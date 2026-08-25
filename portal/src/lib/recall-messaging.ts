import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { decryptMetaToken } from './meta-business';
import { sendTemplate, isRetryableWhatsAppError, WHATSAPP_ERROR } from './whatsapp-api';
import { getTelephonyProvider, isTelephonyConfigured } from './telephony';
import type { TelephonyProvider } from './telephony';
import {
  parseBusinessHours,
  isWithinBusinessHours,
  describeNextOpening,
} from './recall-hours';
import { isNumberBlocked } from './recall-blocklist';
import { summarise } from './recall-transcription';
import { logError } from './observability';

// =============================================================================
// WP-XX (Fase 9) — the messaging engine.
//
// Everything the product actually sells happens here: a missed call turns
// into two messages, one to the person who rang and one to the owner.
//
// The rules below are not politeness. Each exists because its absence
// produces a specific, observed failure:
//
//   90-second delay  — the owner often rings back himself within seconds.
//                      An instant automated "how can we help?" lands while
//                      he is mid-dial and makes the business look like a
//                      robot that talks over its own owner.
//   business hours   — "te contestamos enseguida" sent at 23:40 is a
//                      promise the business then has to break. The
//                      out-of-hours message promises a time it can keep.
//   blocklist        — answering a cold-call sales robot with a warm
//                      greeting from the business's own WhatsApp burns
//                      that number's quality rating on traffic that will
//                      never convert.
//   24h throttle     — the same person ringing four times in an afternoon
//                      is one conversation, not four. Four messages is
//                      how a number gets reported as spam.
//   SMS fallback     — roughly one caller in seven has no WhatsApp. Meta
//                      answers those with 131026 forever, so without a
//                      second channel that caller simply never hears back.
//
// Scheduling comes from the tick, not from timers: "which calls are due"
// is a query, so it survives a restart, cannot leak a pending timeout,
// and is testable by moving `now`. The tick runs every five minutes, so
// the real delay is 90 seconds to about six and a half minutes — which
// for a callback is the right side of the trade either way.
// =============================================================================

/** The pause before messaging a caller. See the header. */
export const CALLER_DELAY_SECONDS = 90;

/** One message per number per client per this window. */
export const CALLER_THROTTLE_HOURS = 24;

/** Give up after this many failed sends in one direction. The sweep runs
 *  every five minutes; without a bound, a permanently-failing row would
 *  be retried roughly three hundred times a day, forever. */
export const MAX_NOTIFY_ATTEMPTS = 3;

/** How long a `recorded` call waits for its transcript before the owner
 *  is told anyway. Whisper being down must delay the message, not cancel
 *  it: "alguien llamó y dejó un mensaje" is still worth knowing. */
export const TRANSCRIPT_GRACE_MINUTES = 10;

/**
 * The templates Meta has to approve for this product.
 *
 * Names and parameter counts are a CONTRACT with what was submitted:
 * sending a different number of parameters fails with 132000 every time,
 * which isRetryableWhatsAppError correctly refuses to retry. Changing a
 * placeholder here means resubmitting the template to Meta.
 */
export const RECALL_TEMPLATES = {
  /** {{1}} business name. Sent when the business is open. */
  callerOpen: { name: 'recall_caller_open', languageCode: 'es' },
  /** {{1}} business name, {{2}} when it opens next. */
  callerClosed: { name: 'recall_caller_closed', languageCode: 'es' },
  /** {{1}} caller number, {{2}} the message. */
  ownerMessage: { name: 'recall_owner_message', languageCode: 'es' },
} as const;

/** Used when a client has no open hours at all in the coming week, so
 *  describeNextOpening has nothing to offer. Promising no time beats
 *  printing an empty parameter, which Meta rejects outright. */
const VAGUE_OPENING = 'en cuanto abramos';

/**
 * Could this number plausibly receive WhatsApp?
 *
 * Spanish geographic numbers (9xx, 8xx) are landlines and essentially
 * never have WhatsApp, so trying Meta first would spend a send, a
 * round-trip and an error code to learn what the prefix already said.
 * Anything else — mobiles, and every non-Spanish number, where we cannot
 * tell — is attempted on WhatsApp first and falls back on 131026.
 */
export function looksLikeWhatsAppCapable(e164: string): boolean {
  const digits = e164.replace(/[^\d+]/g, '');
  if (!digits.startsWith('+34')) return true;
  const national = digits.slice(3);
  return /^[67]/.test(national);
}

/** Terminal values of CallEvent.callerNotifyChannel. */
export type CallerNotifyOutcome = 'whatsapp' | 'sms' | 'blocked' | 'throttled' | 'unreachable';

export interface MessagingDeps {
  /** Injected so tests use the in-memory fake rather than module mocks. */
  telephony?: TelephonyProvider;
  now?: Date;
}

interface CallRow {
  id: string;
  clientId: string;
  subscriptionId: string;
  fromNumber: string | null;
  withheld: boolean;
  outcome: string;
  transcript: string | null;
  startedAt: Date;
  callerNotifyAttempts: number;
  ownerNotifyAttempts: number;
  notifiedCallerAt: Date | null;
  notifiedOwnerAt: Date | null;
  virtualNumber: { e164: string } | null;
  subscription: {
    id: string;
    status: string;
    ownerWhatsapp: string | null;
    timezone: string;
    businessHours: unknown;
    metaConnection: {
      id: string;
      externalId: string;
      status: string;
      accessTokenCiphertext: Buffer;
      accessTokenIv: Buffer;
      accessTokenTag: Buffer;
    } | null;
    client: { name: string; companyName: string | null };
  };
}

const CALL_SELECT = {
  id: true,
  clientId: true,
  subscriptionId: true,
  fromNumber: true,
  withheld: true,
  outcome: true,
  transcript: true,
  startedAt: true,
  callerNotifyAttempts: true,
  ownerNotifyAttempts: true,
  notifiedCallerAt: true,
  notifiedOwnerAt: true,
  virtualNumber: { select: { e164: true } },
  subscription: {
    select: {
      id: true,
      status: true,
      ownerWhatsapp: true,
      timezone: true,
      businessHours: true,
      metaConnection: {
        select: {
          id: true,
          externalId: true,
          status: true,
          accessTokenCiphertext: true,
          accessTokenIv: true,
          accessTokenTag: true,
        },
      },
      client: { select: { name: true, companyName: true } },
    },
  },
} as const;

function businessNameOf(call: CallRow): string {
  return call.subscription.client.companyName ?? call.subscription.client.name;
}

export interface MetaSender {
  token: string;
  phoneNumberId: string;
}

/** The credentials for a client's own WhatsApp number, or null when the
 *  connection is missing, inactive, or its ciphertext no longer decrypts.
 *  Exported because the digest (Fase 10) sends from the same number and
 *  must make the same three checks — duplicating them is how one of the
 *  two ends up sending on a revoked connection. */
export function metaSenderFor(
  connection: {
    id: string;
    externalId: string;
    status: string;
    accessTokenCiphertext: Buffer;
    accessTokenIv: Buffer;
    accessTokenTag: Buffer;
  } | null,
): MetaSender | null {
  if (!connection || connection.status !== 'active') return null;
  try {
    return {
      token: decryptMetaToken({
        ciphertext: connection.accessTokenCiphertext,
        iv: connection.accessTokenIv,
        tag: connection.accessTokenTag,
      }),
      phoneNumberId: connection.externalId,
    };
  } catch (err) {
    logError('recall_messaging.decrypt_failed', err, { connectionId: connection.id }, 'warn');
    return null;
  }
}

function metaCredentialsFor(call: CallRow): MetaSender | null {
  return metaSenderFor(call.subscription.metaConnection);
}

// ---------------------------------------------------------------------------
// Caller notification
// ---------------------------------------------------------------------------

export type CallerNotifyResult =
  | { status: 'sent'; channel: 'whatsapp' | 'sms' }
  | { status: 'skipped'; reason: CallerNotifyOutcome | 'not_found' | 'not_due' | 'already_resolved' }
  | { status: 'failed'; error: string; giveUp: boolean };

/**
 * Has this client already messaged this number recently?
 *
 * Scoped to (client, number) rather than to the call, because the point
 * is the person on the other end: three calls from the same number in one
 * afternoon are one conversation. Reads notifiedCallerAt, which is only
 * ever stamped when a message really went out — the skip outcomes live on
 * callerNotifyChannel precisely so they do not silence the next call too.
 */
async function isThrottled(
  prisma: PrismaClient,
  clientId: string,
  fromNumber: string,
  now: Date,
  excludeCallId: string,
): Promise<boolean> {
  const since = new Date(now.getTime() - CALLER_THROTTLE_HOURS * 60 * 60 * 1000);
  const recent = await prisma.callEvent.findFirst({
    where: {
      clientId,
      fromNumber,
      notifiedCallerAt: { gte: since },
      id: { not: excludeCallId },
    },
    select: { id: true },
  });
  return recent !== null;
}

async function resolveCaller(
  prisma: PrismaClient,
  callId: string,
  channel: CallerNotifyOutcome,
  extra: { sent?: Date; error?: string | null } = {},
): Promise<void> {
  await prisma.callEvent.update({
    where: { id: callId },
    data: {
      callerNotifyChannel: channel,
      ...(extra.sent ? { notifiedCallerAt: extra.sent } : {}),
      callerNotifyError: extra.error ?? null,
    },
  });
}

/**
 * Message the person who rang.
 *
 * Order matters: the cheap local refusals (blocked, throttled) come
 * before anything that costs a provider call, so a blocklisted robot
 * never reaches Meta at all.
 */
export async function notifyCaller(
  prisma: PrismaClient,
  callId: string,
  deps: MessagingDeps = {},
): Promise<CallerNotifyResult> {
  const now = deps.now ?? new Date();
  const call = (await prisma.callEvent.findUnique({
    where: { id: callId },
    select: CALL_SELECT,
  })) as CallRow | null;

  if (!call) return { status: 'skipped', reason: 'not_found' };
  if (call.notifiedCallerAt) return { status: 'skipped', reason: 'already_resolved' };
  if (call.withheld || !call.fromNumber) return { status: 'skipped', reason: 'unreachable' };
  if (call.startedAt.getTime() + CALLER_DELAY_SECONDS * 1000 > now.getTime()) {
    return { status: 'skipped', reason: 'not_due' };
  }

  // A subscription paused between the call and the message is a client who
  // asked us to stop. Stopping means stopping, including for calls already
  // in flight.
  if (call.subscription.status !== 'active') {
    await resolveCaller(prisma, call.id, 'unreachable', { error: 'subscription_not_active' });
    return { status: 'skipped', reason: 'unreachable' };
  }

  if (await isNumberBlocked(prisma, call.subscriptionId, call.fromNumber)) {
    await resolveCaller(prisma, call.id, 'blocked');
    return { status: 'skipped', reason: 'blocked' };
  }

  if (await isThrottled(prisma, call.clientId, call.fromNumber, now, call.id)) {
    await resolveCaller(prisma, call.id, 'throttled');
    return { status: 'skipped', reason: 'throttled' };
  }

  const hours = parseBusinessHours(call.subscription.businessHours);
  const open = isWithinBusinessHours(hours, now, call.subscription.timezone);
  const business = businessNameOf(call);

  // --- WhatsApp first, when the number could plausibly have it ----------
  let lastError = 'no_channel_available';
  let permanent = false;

  if (looksLikeWhatsAppCapable(call.fromNumber)) {
    const credentials = metaCredentialsFor(call);
    if (!credentials) {
      lastError = 'meta_connection_unavailable';
    } else {
      const template = open
        ? { ...RECALL_TEMPLATES.callerOpen, bodyParams: [business] }
        : {
            ...RECALL_TEMPLATES.callerClosed,
            bodyParams: [business, describeNextOpening(hours, now, call.subscription.timezone) ?? VAGUE_OPENING],
          };

      const sent = await sendTemplate(credentials.token, credentials.phoneNumberId, call.fromNumber, template);
      if (sent.ok) {
        await resolveCaller(prisma, call.id, 'whatsapp', { sent: now });
        return { status: 'sent', channel: 'whatsapp' };
      }

      lastError = sent.error;
      // 131026 is the one error that means "try the other channel"
      // rather than "try again later": this number has no WhatsApp, and
      // it never will between now and the next tick.
      if (sent.code !== WHATSAPP_ERROR.UNDELIVERABLE) {
        permanent = !isRetryableWhatsAppError(sent);
        return finishCallerFailure(prisma, call, lastError, permanent);
      }
    }
  }

  // --- SMS fallback -----------------------------------------------------
  const provider = deps.telephony ?? (isTelephonyConfigured() ? getTelephonyProvider() : null);
  const from = call.virtualNumber?.e164;
  if (!provider || !from) {
    return finishCallerFailure(prisma, call, `${lastError}; sms_unavailable`, false);
  }

  const body = open
    ? `Hola, somos ${business}. Hemos visto tu llamada y te contestamos enseguida.`
    : `Hola, somos ${business}. Hemos visto tu llamada y te contestamos ${
        describeNextOpening(hours, now, call.subscription.timezone) ?? VAGUE_OPENING
      }.`;

  const sms = await provider.sendSms({ to: call.fromNumber, from, body });
  if (sms.ok) {
    await resolveCaller(prisma, call.id, 'sms', { sent: now });
    return { status: 'sent', channel: 'sms' };
  }
  return finishCallerFailure(prisma, call, sms.error, false);
}

/** Record a failed attempt, and stop trying once the budget is spent or
 *  the error is one that repetition cannot fix. */
async function finishCallerFailure(
  prisma: PrismaClient,
  call: CallRow,
  error: string,
  permanent: boolean,
): Promise<CallerNotifyResult> {
  const attempts = call.callerNotifyAttempts + 1;
  const giveUp = permanent || attempts >= MAX_NOTIFY_ATTEMPTS;
  await prisma.callEvent.update({
    where: { id: call.id },
    data: {
      callerNotifyAttempts: attempts,
      callerNotifyError: error.slice(0, 500),
      ...(giveUp ? { callerNotifyChannel: 'unreachable' } : {}),
    },
  });
  return { status: 'failed', error, giveUp };
}

// ---------------------------------------------------------------------------
// Owner notification
// ---------------------------------------------------------------------------

export type OwnerNotifyResult =
  | { status: 'sent' }
  | { status: 'skipped'; reason: 'not_found' | 'already_sent' | 'no_owner_number' | 'awaiting_transcript' | 'no_connection' }
  | { status: 'failed'; error: string; giveUp: boolean };

/**
 * Send the owner his message.
 *
 * No delay and no business hours: this is his own phone and his own
 * business, and the whole product promise is that he hears about the lost
 * call in minutes rather than at the end of the day. The 19:00 digest
 * (Fase 10) is a summary, not the notification.
 *
 * A withheld caller still produces one — "alguien llamó y no dejó número"
 * is exactly the kind of thing an owner wants to know, even though there
 * is nobody to ring back.
 */
export async function notifyOwner(
  prisma: PrismaClient,
  callId: string,
  deps: MessagingDeps = {},
): Promise<OwnerNotifyResult> {
  const now = deps.now ?? new Date();
  const call = (await prisma.callEvent.findUnique({
    where: { id: callId },
    select: CALL_SELECT,
  })) as CallRow | null;

  if (!call) return { status: 'skipped', reason: 'not_found' };
  if (call.notifiedOwnerAt) return { status: 'skipped', reason: 'already_sent' };

  const owner = call.subscription.ownerWhatsapp;
  if (!owner) return { status: 'skipped', reason: 'no_owner_number' };

  // Wait for the transcript, but not forever: Whisper being down should
  // delay this message, never cancel it.
  const graceExpired = call.startedAt.getTime() + TRANSCRIPT_GRACE_MINUTES * 60 * 1000 <= now.getTime();
  if (call.outcome === 'recorded' && !call.transcript && !graceExpired) {
    return { status: 'skipped', reason: 'awaiting_transcript' };
  }

  const credentials = metaCredentialsFor(call);
  if (!credentials) return { status: 'skipped', reason: 'no_connection' };

  const sent = await sendTemplate(credentials.token, credentials.phoneNumberId, owner, {
    ...RECALL_TEMPLATES.ownerMessage,
    bodyParams: [describeCaller(call), describeMessage(call)],
  });

  if (sent.ok) {
    await prisma.callEvent.update({
      where: { id: call.id },
      data: { notifiedOwnerAt: now, ownerNotifyError: null },
    });
    return { status: 'sent' };
  }

  const attempts = call.ownerNotifyAttempts + 1;
  const giveUp = !isRetryableWhatsAppError(sent) || attempts >= MAX_NOTIFY_ATTEMPTS;
  await prisma.callEvent.update({
    where: { id: call.id },
    data: { ownerNotifyAttempts: attempts, ownerNotifyError: sent.error.slice(0, 500) },
  });
  return { status: 'failed', error: sent.error, giveUp };
}

/** Template parameters cannot be empty, so every branch yields words. */
function describeCaller(call: CallRow): string {
  if (call.withheld || !call.fromNumber) return 'número oculto';
  return call.fromNumber;
}

function describeMessage(call: CallRow): string {
  if (call.transcript) return summarise(call.transcript, 700);
  if (call.outcome === 'no_message') return 'Colgó sin dejar mensaje.';
  return 'Dejó un mensaje que aún no hemos podido transcribir.';
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

export interface NotificationSweepResult {
  callersScanned: number;
  callersSent: number;
  callersSkipped: number;
  callersFailed: number;
  ownersScanned: number;
  ownersSent: number;
  ownersFailed: number;
}

/**
 * One tick's worth of outbound messaging.
 *
 * Callers first: theirs is the message with a deadline attached — a
 * "we saw your call" that arrives an hour late is worse than useless,
 * while the owner's message is still worth reading whenever it lands.
 *
 * Per-call try/catch, same discipline as conversation-digest.ts and the
 * transcription sweep: one bad row must never cost everyone else their
 * turn.
 */
export async function sweepPendingNotifications(
  prisma: PrismaClient,
  deps: MessagingDeps & { limit?: number } = {},
): Promise<NotificationSweepResult> {
  const now = deps.now ?? new Date();
  const limit = deps.limit ?? 25;
  const due = new Date(now.getTime() - CALLER_DELAY_SECONDS * 1000);

  const result: NotificationSweepResult = {
    callersScanned: 0,
    callersSent: 0,
    callersSkipped: 0,
    callersFailed: 0,
    ownersScanned: 0,
    ownersSent: 0,
    ownersFailed: 0,
  };

  const callers = await prisma.callEvent.findMany({
    where: {
      // NULL is the only "undecided" value; every terminal outcome, sent
      // or skipped, writes this column.
      callerNotifyChannel: null,
      notifiedCallerAt: null,
      withheld: false,
      fromNumber: { not: null },
      // 'pending' calls are still ringing and 'blocked' ones were refused
      // at the door.
      outcome: { in: ['recorded', 'no_message'] },
      startedAt: { lte: due },
      callerNotifyAttempts: { lt: MAX_NOTIFY_ATTEMPTS },
    },
    orderBy: { startedAt: 'asc' },
    take: limit,
    select: { id: true },
  });

  result.callersScanned = callers.length;
  for (const row of callers) {
    try {
      const outcome = await notifyCaller(prisma, row.id, { ...deps, now });
      if (outcome.status === 'sent') result.callersSent += 1;
      else if (outcome.status === 'failed') result.callersFailed += 1;
      else result.callersSkipped += 1;
    } catch (err) {
      result.callersFailed += 1;
      logError('recall_messaging.caller_sweep_item_failed', err, { callEventId: row.id }, 'warn');
    }
  }

  const owners = await prisma.callEvent.findMany({
    where: {
      notifiedOwnerAt: null,
      outcome: { in: ['recorded', 'no_message', 'withheld'] },
      ownerNotifyAttempts: { lt: MAX_NOTIFY_ATTEMPTS },
      subscription: { status: 'active', ownerWhatsapp: { not: null } },
    },
    orderBy: { startedAt: 'asc' },
    take: limit,
    select: { id: true },
  });

  result.ownersScanned = owners.length;
  for (const row of owners) {
    try {
      const outcome = await notifyOwner(prisma, row.id, { ...deps, now });
      if (outcome.status === 'sent') result.ownersSent += 1;
      else if (outcome.status === 'failed') result.ownersFailed += 1;
    } catch (err) {
      result.ownersFailed += 1;
      logError('recall_messaging.owner_sweep_item_failed', err, { callEventId: row.id }, 'warn');
    }
  }

  return result;
}

/** Fire-and-forget owner notification for the recording/transcription
 *  path, so the owner hears in seconds rather than waiting for the next
 *  tick. The sweep still guarantees eventual delivery, which is why any
 *  error here can be swallowed. */
export function notifyOwnerInBackground(prisma: PrismaClient, callId: string): void {
  void notifyOwner(prisma, callId).catch((err) => {
    logError('recall_messaging.background_owner_failed', err, { callEventId: callId }, 'warn');
  });
}
