import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { logError } from './observability';

// =============================================================================
// WP-XX — inbound call handling for the 'recall' product.
//
// The shape of the flow, and why:
//
//   caller dials the client's own mobile
//     → no answer after 25s → the CARRIER forwards to our virtual number
//     → Twilio POSTs here
//     → we play the OWNER'S OWN RECORDED VOICE, record the message, hang up
//
// We only ever see calls the client did not answer. Conditional forwarding
// (**61*) means the ones they pick up never reach us at all — worth
// stating because it is also the RGPD posture: we do not intercept calls,
// we take messages the client would otherwise have lost.
//
// TwiML is built as a string rather than with a library. It is a handful
// of elements and the alternative is a dependency whose main value
// (fluent builders) does not pay for itself here. Everything
// caller-controlled that reaches the XML is escaped — see escapeXml.
// =============================================================================

/** Twilio's placeholder for a withheld caller ID, plus the values seen
 *  when a carrier passes nothing at all. A withheld call can never be
 *  called back, so it must never be counted as recoverable. */
const ANONYMOUS_MARKERS = new Set(['anonymous', 'unavailable', 'restricted', 'private', '+266696687', '266696687']);

export function isWithheldCaller(from: string | null | undefined): boolean {
  if (!from) return true;
  return ANONYMOUS_MARKERS.has(from.trim().toLowerCase());
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface TwimlOptions {
  /** Absolute URL Twilio should GET to play the owner's greeting. Null
   *  when the owner has not recorded one yet. */
  greetingUrl: string | null;
  /** Absolute URL Twilio should POST to once the recording is ready. */
  recordingCallbackUrl: string;
  /** Seconds. Long enough for a real problem description, short enough
   *  that a pocket-dial does not bill us for five minutes. */
  maxLengthSeconds?: number;
}

/**
 * The normal flow: greeting → beep → record → hang up.
 *
 * The greeting is the owner's own voice by design — it is what makes the
 * caller stay on the line, what stops the assistant from feeling like an
 * impersonation, and what satisfies the EU AI Act's transparency duty,
 * because the owner's own recording is what announces that an assistant
 * is taking the message.
 *
 * When no greeting has been recorded we fall back to a NEUTRAL synthetic
 * voice that never claims to be the owner. Silence would be worse, and
 * so would a synthetic voice pretending to be Juan.
 */
export function buildRecordTwiml(opts: TwimlOptions): string {
  const maxLength = opts.maxLengthSeconds ?? 120;
  const intro = opts.greetingUrl
    ? `<Play>${escapeXml(opts.greetingUrl)}</Play>`
    : `<Say language="es-ES">Gracias por llamar. En este momento no podemos atenderte. Deja tu mensaje después de la señal y te llamamos en cuanto podamos.</Say>`;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    intro,
    `<Record maxLength="${maxLength}" playBeep="true" trim="trim-silence"`,
    ` recordingStatusCallback="${escapeXml(opts.recordingCallbackUrl)}"`,
    ' recordingStatusCallbackEvent="completed" recordingStatusCallbackMethod="POST"/>',
    '<Hangup/>',
    '</Response>',
  ].join('');
}

/**
 * What an unrecognised or inactive number answers.
 *
 * This must still be VALID TwiML with a spoken message: returning an
 * error status makes Twilio play its own failure tone to a real person
 * who dialled a real business. The caller should never be able to tell
 * that our side is misconfigured.
 */
export function buildUnavailableTwiml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    '<Say language="es-ES">Gracias por llamar. En este momento no podemos atender tu llamada. Inténtalo de nuevo más tarde.</Say>',
    '<Hangup/>',
    '</Response>',
  ].join('');
}

export interface ResolvedCallTarget {
  subscriptionId: string;
  clientId: string;
  tenantId: string | null;
  virtualNumberId: string;
  hasGreeting: boolean;
}

/**
 * Which client owns the number that was dialled.
 *
 * Only an `assigned` number belonging to a subscription that is actually
 * live answers. A number still in the pool, or one whose subscription is
 * paused or half-onboarded, gets the unavailable message — answering
 * with a half-configured flow would take a message nobody is watching.
 */
export async function resolveCallTarget(
  prisma: PrismaClient,
  toNumber: string,
): Promise<ResolvedCallTarget | null> {
  const number = await prisma.virtualNumber.findUnique({
    where: { e164: toNumber },
    select: {
      id: true,
      status: true,
      subscription: {
        select: {
          id: true,
          clientId: true,
          tenantId: true,
          status: true,
          greetingAudio: true,
        },
      },
    },
  });
  if (!number || number.status !== 'assigned' || !number.subscription) return null;
  const sub = number.subscription;
  // 'active' only: a paused subscription is a client who asked us to stop.
  if (sub.status !== 'active') return null;

  return {
    subscriptionId: sub.id,
    clientId: sub.clientId,
    tenantId: sub.tenantId,
    virtualNumberId: number.id,
    hasGreeting: sub.greetingAudio !== null,
  };
}

/**
 * Record the call, idempotently.
 *
 * Twilio delivers webhooks at-least-once and retries anything non-2xx, so
 * a duplicate delivery must find the existing row rather than create a
 * second one — hence the upsert on the unique CallSid rather than a
 * create. The update side is deliberately empty: a retry carries the same
 * facts, and overwriting `startedAt` on a retry would corrupt the very
 * timestamp the stuck/al-day reporting is built on.
 */
export async function recordIncomingCall(
  prisma: PrismaClient,
  target: ResolvedCallTarget,
  call: {
    callSid: string;
    from: string | null;
    to: string;
    startedAt?: Date;
    /** Forced terminal outcome. Only the blocklist path uses it, to
     *  record that the call happened while making sure nothing later
     *  treats it as a message waiting to be handled. */
    outcome?: 'blocked';
  },
): Promise<{ id: string; outcome: string }> {
  const withheld = isWithheldCaller(call.from);
  return prisma.callEvent.upsert({
    where: { twilioCallSid: call.callSid },
    create: {
      clientId: target.clientId,
      subscriptionId: target.subscriptionId,
      tenantId: target.tenantId,
      virtualNumberId: target.virtualNumberId,
      twilioCallSid: call.callSid,
      fromNumber: withheld ? null : call.from,
      withheld,
      toNumber: call.to,
      startedAt: call.startedAt ?? new Date(),
      // 'withheld' is terminal from the start: there is no number to
      // message back, so no later step can improve on it. Everything
      // else stays 'pending' until the recording callback decides.
      outcome: call.outcome ?? (withheld ? 'withheld' : 'pending'),
    },
    update: {},
    select: { id: true, outcome: true },
  });
}

/**
 * Attach a finished recording to its call.
 *
 * Keyed on CallSid, not RecordingSid, because the recording callback is
 * the first time we see the RecordingSid at all. A zero-length recording
 * means the caller hung up during the greeting or left silence — that is
 * `no_message`, which is a real and common outcome, not a failure.
 *
 * The audio itself is never fetched or stored: only the SID and URL,
 * which the 30-day purge (Fase 6) uses to delete it at Twilio.
 */
export async function attachRecording(
  prisma: PrismaClient,
  input: { callSid: string; recordingSid: string; recordingUrl: string; durationSeconds: number | null },
): Promise<{ ok: true; callEventId: string } | { ok: false; error: 'call_not_found' }> {
  const existing = await prisma.callEvent.findUnique({
    where: { twilioCallSid: input.callSid },
    select: { id: true, outcome: true },
  });
  if (!existing) return { ok: false, error: 'call_not_found' };

  const hasMessage = (input.durationSeconds ?? 0) > 0;
  try {
    await prisma.callEvent.update({
      where: { id: existing.id },
      data: {
        recordingSid: input.recordingSid,
        recordingUrl: input.recordingUrl,
        recordingDurationSeconds: input.durationSeconds,
        endedAt: new Date(),
        // Never downgrade a terminal outcome: a withheld call that
        // somehow also produced a recording is still un-callable-back.
        outcome: existing.outcome === 'withheld' ? 'withheld' : hasMessage ? 'recorded' : 'no_message',
      },
    });
  } catch (err) {
    // The unique on recordingSid can collide when Twilio re-delivers the
    // same callback; that is a duplicate, not a failure.
    logError('recall_calls.attach_recording_failed', err, { callSid: input.callSid }, 'warn');
    return { ok: true, callEventId: existing.id };
  }
  return { ok: true, callEventId: existing.id };
}
