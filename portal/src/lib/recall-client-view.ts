import 'server-only';
import type { PrismaClient } from '@prisma/client';
import {
  computeMonthlyMetrics,
  localMonthFor,
  monthBounds,
  shiftLocalMonth,
  type MonthlyMetrics,
} from './recall-reports';
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

/** Upper bound on one month's call list. A month is the unit the page
 *  navigates by, so this is a safety rail rather than the usual case —
 *  even the busiest tier runs well under it. When it does bite, the page
 *  SAYS so: a list that silently stops is worse than a short one,
 *  because nothing tells the reader anything is missing. */
export const CALLS_PER_MONTH_CAP = 200;

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
  /** The month currently on screen. The page renders it unlinked and
   *  marked, rather than removing it from the list. */
  isSelected: boolean;
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
      /** The month being viewed, 'YYYY-MM' in the client's timezone. */
      localMonth: string;
      /** Neighbouring months inside the range that has data, or null at
       *  either end. The page renders these as its only navigation. */
      previousMonth: string | null;
      nextMonth: string | null;
      /** Always computed live for whichever month is shown, so a past
       *  month and the current one are produced the same way. */
      metrics: MonthlyMetrics;
      /** Every OTHER month, as the table that doubles as navigation. */
      history: RecallMonthSummary[];
      calls: RecallCallSummary[];
      /** True when the month had more calls than the cap. */
      truncated: boolean;
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
  opts: { now?: Date; month?: string | null } = {},
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

  const currentMonth = localMonthFor(now, subscription.timezone);

  // The earliest month worth offering: whatever the roll-up has, or
  // this month when it has nothing yet. Without a floor the previous
  // arrow would walk backwards forever through empty months.
  const earliestRow = await prisma.recallUsageMonth.findFirst({
    where: { subscriptionId: subscription.id },
    orderBy: { localMonth: 'asc' },
    select: { localMonth: true },
  });
  const earliestMonth =
    earliestRow && earliestRow.localMonth < currentMonth ? earliestRow.localMonth : currentMonth;

  // The month key arrives from the query string, so it is validated and
  // clamped rather than trusted: a malformed or out-of-range value must
  // land somewhere real instead of rendering an empty month.
  const localMonth = clampMonth(opts.month, earliestMonth, currentMonth);
  const { since, until } = monthBounds(localMonth, subscription.timezone);

  const previousMonth = localMonth > earliestMonth ? shiftLocalMonth(localMonth, -1) : null;
  const nextMonth = localMonth < currentMonth ? shiftLocalMonth(localMonth, 1) : null;

  const [metrics, historyRows, callRows] = await Promise.all([
    computeMonthlyMetrics(prisma, subscription, since, until),
    prisma.recallUsageMonth.findMany({
      // EVERY month, including the one on screen: this table is the
      // navigation, and a list that drops its own selected row
      // reshuffles under the reader every time they use it.
      where: { subscriptionId: subscription.id },
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
        startedAt: { gte: since, lt: until },
        // A blocked caller is one the client asked us to silence. Listing
        // them back to him is noise about a decision he already made.
        outcome: { not: 'blocked' },
      },
      orderBy: { startedAt: 'desc' },
      // One over the cap, so the page can tell the difference between
      // "exactly a capful" and "there are more".
      take: CALLS_PER_MONTH_CAP + 1,
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

  const truncated = callRows.length > CALLS_PER_MONTH_CAP;

  return {
    state: 'active',
    virtualNumber,
    localMonth,
    previousMonth,
    nextMonth,
    metrics,
    history: buildHistory(historyRows, localMonth, metrics),
    calls: truncated ? callRows.slice(0, CALLS_PER_MONTH_CAP) : callRows,
    truncated,
    // Surfaced rather than hard-coded in the page so the number the client
    // is told always matches the number the purge job actually enforces.
    recordingRetentionDays: RECORDING_RETENTION_DAYS,
  };
}

interface UsageRow {
  localMonth: string;
  calls: number;
  recordedCalls: number;
  callSeconds: number;
  reviewRequests: number;
}

/**
 * The month list, newest first, with the selected month always present.
 *
 * Its figures come from the LIVE metrics rather than from its roll-up
 * row, so the row and the summary above it can never show two numbers
 * for the same month. The other rows are the stored roll-up, which for
 * a month that isn't on screen is exactly what it should be — and for
 * the current month, when some other month is selected, lags by at most
 * one scheduler tick.
 *
 * The selected month is synthesised when no roll-up row exists yet,
 * which is the normal state of a month that started this morning.
 */
export function buildHistory(
  rows: readonly UsageRow[],
  selectedMonth: string,
  metrics: { calls: number; recordedCalls: number; callSeconds: number; reviewRequests: number },
): RecallMonthSummary[] {
  const mapped = rows.map((row) => ({
    localMonth: row.localMonth,
    calls: row.calls,
    recordedCalls: row.recordedCalls,
    minutes: Math.round(row.callSeconds / 60),
    reviewRequests: row.reviewRequests,
    isSelected: false,
  }));

  const selected: RecallMonthSummary = {
    localMonth: selectedMonth,
    calls: metrics.calls,
    recordedCalls: metrics.recordedCalls,
    minutes: Math.round(metrics.callSeconds / 60),
    reviewRequests: metrics.reviewRequests,
    isSelected: true,
  };

  const withoutSelected = mapped.filter((row) => row.localMonth !== selectedMonth);
  return [...withoutSelected, selected].sort((a, b) => (a.localMonth < b.localMonth ? 1 : -1));
}

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Read a month key off the query string.
 *
 * Anything unparseable, or outside the range that actually has data,
 * falls back to the newest month. A URL is user input: the failure mode
 * to avoid is an empty page that looks like "you had no calls" when it
 * really means "that month never existed".
 */
export function clampMonth(
  requested: string | null | undefined,
  earliest: string,
  latest: string,
): string {
  if (!requested || !MONTH_KEY.test(requested)) return latest;
  if (requested < earliest) return earliest;
  if (requested > latest) return latest;
  return requested;
}
