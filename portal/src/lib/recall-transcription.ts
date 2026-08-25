import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { transcribeRecording, isWhisperConfigured } from './whisper';
import { logError } from './observability';

// =============================================================================
// WP-XX — turn a recorded message into a transcript and a Lead.
//
// Two entry points on purpose:
//
//   transcribeCallEvent()  — one call, invoked right after the recording
//                            webhook so the owner gets his WhatsApp in
//                            seconds rather than minutes.
//   sweepPendingTranscriptions() — the safety net, run by the scheduler,
//                            for everything the inline path missed
//                            because Whisper was down or slow.
//
// The webhook itself must NOT await the inline path: Twilio's callback
// has to return promptly, and a slow transcription would push it into
// retry territory (which would then re-deliver and duplicate work). The
// caller fires and forgets; the sweep is what guarantees eventual
// completion.
//
// A missed call with a message IS a lead, so it reuses the existing Lead
// model rather than duplicating it — same treatment the chat channels
// get, which also means the client's existing /portal/leads screen and
// the operator's LeadsSummaryPanel show phone leads with no extra work.
// =============================================================================

/** Leads carry a short summary, not the whole transcript — the full text
 *  stays on the CallEvent. Cut on a word boundary so the operator never
 *  sees a half-word. */
const SUMMARY_MAX = 280;

export function summarise(transcript: string, max = SUMMARY_MAX): string {
  const clean = transcript.trim().replace(/\s+/g, ' ');
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export type TranscribeOutcome =
  | { status: 'transcribed'; leadId: string | null }
  | { status: 'skipped'; reason: 'not_found' | 'no_recording' | 'already_done' | 'not_configured' }
  | { status: 'failed'; error: string; retryable: boolean };

/**
 * Transcribe one call and, when there are words, create its Lead.
 *
 * Idempotent: a second run on an already-transcribed call short-circuits,
 * and lead creation is guarded by the CallEvent's own leadId, so the
 * sweep racing the inline path cannot produce two leads for one call.
 */
export async function transcribeCallEvent(
  prisma: PrismaClient,
  callEventId: string,
  auth?: { accountSid: string; authToken: string },
): Promise<TranscribeOutcome> {
  if (!isWhisperConfigured()) return { status: 'skipped', reason: 'not_configured' };

  const call = await prisma.callEvent.findUnique({
    where: { id: callEventId },
    select: {
      id: true,
      clientId: true,
      tenantId: true,
      fromNumber: true,
      recordingUrl: true,
      transcript: true,
      leadId: true,
      outcome: true,
    },
  });
  if (!call) return { status: 'skipped', reason: 'not_found' };
  if (!call.recordingUrl) return { status: 'skipped', reason: 'no_recording' };
  if (call.transcript) return { status: 'skipped', reason: 'already_done' };

  const result = await transcribeRecording(call.recordingUrl, { auth });
  if (!result.ok) {
    await prisma.callEvent
      .update({ where: { id: call.id }, data: { transcriptionError: result.error.slice(0, 500) } })
      .catch(() => null);
    return { status: 'failed', error: result.error, retryable: result.retryable };
  }

  const leadId = await prisma.$transaction(async (tx) => {
    await tx.callEvent.update({
      where: { id: call.id },
      data: { transcript: result.text, transcribedAt: new Date(), transcriptionError: null },
    });

    // No lead for a call nobody can ring back, and none for a call that
    // already produced one. A withheld caller leaving a message is still
    // un-callable, so it stays a CallEvent the owner can read and not a
    // Lead his sales pipeline will nag him about.
    if (call.leadId || call.outcome === 'withheld' || !call.fromNumber) return null;

    const lead = await tx.lead.create({
      data: {
        clientId: call.clientId,
        tenantId: call.tenantId,
        contactPhone: call.fromNumber,
        summary: summarise(result.text),
        channel: 'phone',
      },
    });
    await tx.leadAudit.create({
      data: {
        leadId: lead.id,
        clientId: lead.clientId,
        tenantId: lead.tenantId,
        action: 'created',
        statusBefore: null,
        statusAfter: 'nuevo',
        actorId: 'system:recall',
      },
    });
    await tx.callEvent.update({ where: { id: call.id }, data: { leadId: lead.id } });
    return lead.id;
  });

  return { status: 'transcribed', leadId };
}

/** Fire-and-forget wrapper for the recording webhook. Twilio's callback
 *  must return promptly — a slow transcription would push it into retry,
 *  which then re-delivers and duplicates work. Errors are swallowed
 *  because the sweep is what guarantees eventual completion.
 *
 *  `onSettled` runs after the attempt finishes, success or failure. It is
 *  how the owner notification is chained on without this module having to
 *  know that messaging exists — the caller wires the two together, so the
 *  dependency stays one-way and there is no import cycle. It fires even
 *  on failure because notifyOwner has its own grace period: a transcript
 *  that never arrives should delay the owner's message, not cancel it. */
export function transcribeCallEventInBackground(
  prisma: PrismaClient,
  callEventId: string,
  auth?: { accountSid: string; authToken: string },
  onSettled?: () => void,
): void {
  void transcribeCallEvent(prisma, callEventId, auth)
    .catch((err) => {
      logError('recall_transcription.background_failed', err, { callEventId }, 'warn');
    })
    .finally(() => {
      try {
        onSettled?.();
      } catch (err) {
        logError('recall_transcription.on_settled_failed', err, { callEventId }, 'warn');
      }
    });
}

export interface SweepResult {
  scanned: number;
  transcribed: number;
  failed: number;
}

/**
 * Catch up everything the inline path missed.
 *
 * Ordered oldest-first so a backlog drains in the order the calls came
 * in — a message from this morning matters more than one from a minute
 * ago. Bounded per run so one sweep cannot exceed the scheduler's
 * request budget; the next tick continues.
 *
 * Per-call try/catch, same discipline as conversation-digest.ts: one bad
 * row must never abort the sweep for everyone else.
 */
export async function sweepPendingTranscriptions(
  prisma: PrismaClient,
  opts: { limit?: number; auth?: { accountSid: string; authToken: string } } = {},
): Promise<SweepResult> {
  if (!isWhisperConfigured()) return { scanned: 0, transcribed: 0, failed: 0 };

  const pending = await prisma.callEvent.findMany({
    where: {
      outcome: 'recorded',
      transcript: null,
      recordingUrl: { not: null },
      // Never resurrect a recording that has already been purged: the
      // audio is gone from Twilio, so there is nothing left to transcribe.
      recordingDeletedAt: null,
    },
    orderBy: { startedAt: 'asc' },
    take: opts.limit ?? 20,
    select: { id: true },
  });

  const result: SweepResult = { scanned: pending.length, transcribed: 0, failed: 0 };
  for (const row of pending) {
    try {
      const outcome = await transcribeCallEvent(prisma, row.id, opts.auth);
      if (outcome.status === 'transcribed') result.transcribed += 1;
      else if (outcome.status === 'failed') result.failed += 1;
    } catch (err) {
      result.failed += 1;
      logError('recall_transcription.sweep_item_failed', err, { callEventId: row.id }, 'warn');
    }
  }
  return result;
}
