import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { listRecallQueue, isStuck, stuckThresholdDays } from './recall';
import {
  renderStuck,
  sendOperatorNotification,
  resolveOperatorRecipients,
  utcDayKey,
} from './operator-notify';
import { logError } from './observability';

// =============================================================================
// WP-XX — tell an operator when an alta has stalled.
//
// The queue at /admin/portal/recall shows this too, but a queue only
// helps someone who opens it. The failure this product actually dies of
// — client pays, never dials the forwarding codes, cancels at three weeks
// — takes about a week to become expensive and nobody opens a queue every
// morning for months. So it pushes.
//
// Reuses the existing 'stuck' notification kind rather than inventing
// one: it already has a template, an allowlist, recipients from
// KAIRIKOS_OPERATOR_EMAILS, and — the part that matters most here —
// deduplication on (clientId, kind, day), so a client stalled for nine
// days produces nine emails at most, not one per tick.
//
// That per-day dedup is also why this can safely run on every scheduler
// tick without any cadence logic of its own.
// =============================================================================

export interface StuckAlertResult {
  scanned: number;
  stuck: number;
  notified: number;
  deduped: number;
  failed: number;
}

export async function notifyStuckOnboardings(
  prisma: PrismaClient,
  opts: { now?: Date; portalBaseUrl?: string } = {},
): Promise<StuckAlertResult> {
  const now = opts.now ?? new Date();
  const result: StuckAlertResult = { scanned: 0, stuck: 0, notified: 0, deduped: 0, failed: 0 };

  const recipients = resolveOperatorRecipients(process.env.KAIRIKOS_OPERATOR_EMAILS);
  const rows = await listRecallQueue(prisma);
  result.scanned = rows.length;

  const stuckRows = rows.filter((row) => isStuck(row.status, row.since, now));
  result.stuck = stuckRows.length;
  // Still report how many are stuck even when nobody is configured to
  // receive the mail — the count is useful telemetry on its own, and
  // silently returning zero would hide a misconfiguration.
  if (recipients.length === 0) return result;

  const day = utcDayKey(now);

  for (const row of stuckRows) {
    try {
      const existing = await prisma.operatorNotification.findUnique({
        where: { clientId_kind_day: { clientId: row.clientId, kind: 'stuck', day } },
        select: { id: true },
      });
      if (existing) {
        result.deduped += 1;
        continue;
      }

      const hoursSince = Math.floor((now.getTime() - row.since.getTime()) / (60 * 60 * 1000));
      const rendered = renderStuck({
        clientId: row.clientId,
        clientName: row.clientName,
        // The 'stuck' template calls this a milestone because it was
        // written for the chatbot's T+0/T+3 timeline. Here the useful
        // thing to name is the state the alta is parked in, plus how
        // long it is allowed to sit there before anyone calls it late.
        milestone: `${row.status} (umbral ${stuckThresholdDays(row.status) ?? '—'}d)`,
        hoursSince,
        portalUrl: `${opts.portalBaseUrl ?? process.env.NEXT_PUBLIC_PORTAL_URL ?? ''}/admin/portal/recall`,
      });

      const sent = await sendOperatorNotification({
        kind: 'stuck',
        to: recipients,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      });
      if (!sent.ok) {
        result.failed += 1;
        continue;
      }

      // Persist AFTER sending, and only on success: a row written before
      // a failed send would dedupe away tomorrow's retry and the operator
      // would never hear about this client at all.
      await prisma.operatorNotification.create({
        data: {
          clientId: row.clientId,
          kind: 'stuck',
          day,
          subject: rendered.subject,
          context: JSON.stringify({ status: row.status, since: row.since.toISOString(), hoursSince }),
          resendMessageId: 'messageId' in sent ? sent.messageId : null,
          sentAt: now,
        },
      });
      result.notified += 1;
    } catch (err) {
      result.failed += 1;
      logError('recall_stuck_alerts.item_failed', err, { clientId: row.clientId }, 'warn');
    }
  }

  return result;
}
