import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { logError } from './observability';

// =============================================================================
// WP-XX — 30-day recording retention.
//
// This is where the RGPD promise is actually kept, and it is worth being
// precise about what that means: the recording lives at Twilio, not here,
// so "deleting it" means calling Twilio's API. Stamping
// `recordingDeletedAt` locally without that call would leave the audio of
// a third party's voice sitting on someone else's servers while our own
// records claimed it was gone — the worst of both worlds.
//
// So: delete THERE first, stamp HERE second. If the provider call fails,
// the row keeps `recordingDeletedAt` null and the next sweep tries again.
// The consequence we accept is retrying; the one we refuse is a false
// claim of deletion.
//
// Note this deletes the AUDIO, not the CallEvent. The transcript, the
// caller's number and the outcome stay: they are what the client bought,
// and they are ordinary business records under the client's own lawful
// basis. Voice recordings are the sensitive part with the short clock.
// =============================================================================

export const RECORDING_RETENTION_DAYS = 30;

export interface PurgeResult {
  scanned: number;
  purged: number;
  failed: number;
}

async function deleteTwilioRecording(
  recordingSid: string,
  auth: { accountSid: string; authToken: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${auth.accountSid}/Recordings/${encodeURIComponent(recordingSid)}.json`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Basic ${Buffer.from(`${auth.accountSid}:${auth.authToken}`).toString('base64')}`,
        },
      },
    );
    // 204 is the success case. 404 means it is already gone — which is
    // the desired end state, so treat it as done rather than retrying
    // forever against something that no longer exists.
    if (res.status === 204 || res.status === 404) return { ok: true };
    return { ok: false, error: `twilio_${res.status}` };
  } catch (err) {
    logError('recall_retention.delete_failed', err, { recordingSid }, 'warn');
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}

/**
 * Delete every recording past its retention window.
 *
 * Bounded per run so one sweep cannot exceed the request budget; the next
 * tick continues. Ordered oldest-first so the most overdue recordings —
 * the ones furthest past the promise — go first.
 */
export async function purgeExpiredRecordings(
  prisma: PrismaClient,
  auth: { accountSid: string; authToken: string },
  opts: { limit?: number; now?: Date; retentionDays?: number } = {},
): Promise<PurgeResult> {
  const now = opts.now ?? new Date();
  const retentionDays = opts.retentionDays ?? RECORDING_RETENTION_DAYS;
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  const expired = await prisma.callEvent.findMany({
    where: {
      recordingSid: { not: null },
      recordingDeletedAt: null,
      startedAt: { lt: cutoff },
    },
    orderBy: { startedAt: 'asc' },
    take: opts.limit ?? 50,
    select: { id: true, recordingSid: true },
  });

  const result: PurgeResult = { scanned: expired.length, purged: 0, failed: 0 };
  for (const row of expired) {
    if (!row.recordingSid) continue;
    const deleted = await deleteTwilioRecording(row.recordingSid, auth);
    if (!deleted.ok) {
      result.failed += 1;
      continue;
    }
    try {
      await prisma.callEvent.update({
        where: { id: row.id },
        data: {
          recordingDeletedAt: now,
          // The URL is dead once the audio is gone; keeping it would
          // invite a later reader to try fetching something that isn't
          // there. The SID stays as the audit trail of what was deleted.
          recordingUrl: null,
        },
      });
      result.purged += 1;
    } catch (err) {
      // Deleted at Twilio but not stamped here. The next sweep will
      // retry, hit Twilio's 404, treat it as done, and stamp it — which
      // is exactly why 404 counts as success above.
      logError('recall_retention.stamp_failed', err, { callEventId: row.id }, 'warn');
      result.failed += 1;
    }
  }
  return result;
}
