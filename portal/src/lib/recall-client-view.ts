import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { computeMonthlyMetrics, localMonthFor, monthBounds, type MonthlyMetrics } from './recall-reports';
import { RECORDING_RETENTION_DAYS } from './recall-retention';

// =============================================================================
// WP-XX — what a 'recall' client sees when they choose to log in.
//
// READ-ONLY, and that is a design constraint rather than a phase-one
// shortcut. The owner decides which calls became a job by REPLYING TO THE
// 19:00 DIGEST, and that reply is what writes
// RecallDigest.selectedCallEventIds, which in turn decides who gets asked
// for a Google review. A second place to make that same decision would
// give one decision two writers, and they would disagree — in the half of
// the product that has a policy dimension.
//
// So: the portal shows, WhatsApp decides.
//
// The product still never REQUIRES a login. A plumber runs this entirely
// from the WhatsApp he already has open; this page exists for the once or
// twice a month he wants to see the numbers himself — and, not
// incidentally, for the portal home to be able to show him the rest of
// the catalogue while he is there.
//
// Every figure comes from computeMonthlyMetrics, the SAME function that
// builds the WhatsApp monthly report. Recomputing them here would let the
// portal and the message he already received disagree in front of him.
// =============================================================================

/** How many months of history the client sees. A year is enough to show a
 *  trend and short enough that the page stays one screen. */
export const HISTORY_MONTHS = 12;

/** How many recent calls are listed. The full history lives in the
 *  operator's panel; this answers "what happened lately", not "give me
 *  everything". */
export const RECENT_CALLS = 20;

export interface RecallCallSummary {
  id: string;
  startedAt: Date;
  fromNumber: string | null;
  withheld: boolean;
  outcome: string;
  transcript: string | null;
  /** 'whatsapp' | 'sms' | 'blocked' | 'throttled' | 'unreachable' | null */
  callerNotifyChannel: string | null;
  notifiedCallerAt: Date | null;
}

export interface RecallMonthSummary {
  localMonth: string;
  calls: number;
  recordedCalls: number;
  minutes: number;
  reviewRequests: number;
}

export type RecallClientView =
  | { state: 'not_contracted' }
  /** Contracted and paid, but the service is not answering calls yet —
   *  usually waiting on the client to set up the divert on his own line.
   *  Showing an empty dashboard here would read as "we sold you nothing". */
  | { state: 'onboarding'; status: string; since: Date; virtualNumber: string | null }
  | {
      state: 'active';
      virtualNumber: string | null;
      localMonth: string;
      metrics: MonthlyMetrics;
      history: RecallMonthSummary[];
      calls: RecallCallSummary[];
      recordingRetentionDays: number;
    };

/**
 * Load one client's own view of their recall service.
 *
 * Scoped by clientId at every step — this is the only place in the
 * product where recall data is read on behalf of the end client rather
 * than an operator, so nothing here may take an id from anywhere but the
 * session.
 *
 * `recall` is not exempt from the one-row-per-client uniqueness that only
 * 'web' escapes, so there is at most one subscription and no picker is
 * needed.
 */
export async function loadRecallClientView(
  prisma: PrismaClient,
  clientId: string,
  opts: { now?: Date } = {},
): Promise<RecallClientView> {
  const now = opts.now ?? new Date();

  const subscription = await prisma.recallSubscription.findFirst({
    where: { clientId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      clientId: true,
      status: true,
      createdAt: true,
      activatedAt: true,
      timezone: true,
      googleConnectionId: true,
      virtualNumber: { select: { e164: true } },
    },
  });

  if (!subscription) return { state: 'not_contracted' };

  const virtualNumber = subscription.virtualNumber?.e164 ?? null;

  // 'paused' and 'cancelled' land here too: a client who stopped the
  // service should see why rather than an empty dashboard implying it is
  // still running.
  if (subscription.status !== 'active') {
    return {
      state: 'onboarding',
      status: subscription.status,
      since: subscription.activatedAt ?? subscription.createdAt,
      virtualNumber,
    };
  }

  const localMonth = localMonthFor(now, subscription.timezone);
  const { since, until } = monthBounds(localMonth, subscription.timezone);

  const [metrics, historyRows, callRows] = await Promise.all([
    computeMonthlyMetrics(prisma, subscription, since, until),
    prisma.recallUsageMonth.findMany({
      where: {
        subscriptionId: subscription.id,
        // The current month is shown live in the summary above the
        // table. Listing it here too would print it twice on one
        // screen AND let the two disagree: the summary is computed
        // now, this row was written by the last roll-up, so between
        // ticks they differ by whatever came in since.
        localMonth: { lt: localMonth },
      },
      orderBy: { localMonth: 'desc' },
      take: HISTORY_MONTHS,
      select: {
        localMonth: true,
        calls: true,
        recordedCalls: true,
        callSeconds: true,
        reviewRequests: true,
      },
    }),
    prisma.callEvent.findMany({
      where: {
        subscriptionId: subscription.id,
        // A blocked caller is one the client asked us to silence. Listing
        // them back to him is noise about a decision he already made.
        outcome: { not: 'blocked' },
      },
      orderBy: { startedAt: 'desc' },
      take: RECENT_CALLS,
      select: {
        id: true,
        startedAt: true,
        fromNumber: true,
        withheld: true,
        outcome: true,
        transcript: true,
        callerNotifyChannel: true,
        notifiedCallerAt: true,
      },
    }),
  ]);

  return {
    state: 'active',
    virtualNumber,
    localMonth,
    metrics,
    history: historyRows.map((row) => ({
      localMonth: row.localMonth,
      calls: row.calls,
      recordedCalls: row.recordedCalls,
      minutes: Math.round(row.callSeconds / 60),
      reviewRequests: row.reviewRequests,
    })),
    calls: callRows,
    // Surfaced rather than hard-coded in the page so the number the client
    // is told always matches the number the purge job actually enforces.
    recordingRetentionDays: RECORDING_RETENTION_DAYS,
  };
}
