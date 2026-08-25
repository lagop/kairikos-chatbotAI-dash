import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { sendTemplate } from './whatsapp-api';
import { metaSenderFor } from './recall-messaging';
import { localDateFor, localMinutesFor } from './recall-digest';
import {
  renderUsageSpike,
  resolveOperatorRecipients,
  sendOperatorNotification,
} from './operator-notify';
import { logError } from './observability';

// =============================================================================
// WP-XX (Fase 11) — the monthly report, and what it is measured from.
//
// THE REPORT IS THE RETENTION MECHANISM. A client who cannot see what he
// got cancels in month two, not because the product failed but because
// nothing ever told him it worked. Recovered calls are invisible by
// nature: the whole point is that they stopped being lost, and a call
// that was never lost leaves no impression.
//
// THE METERING IS NOT BILLING. The pack is flat rate. This exists to
// notice the one client whose consumption stops resembling everyone
// else's — usually a misconfigured divert or a wave of spam, occasionally
// someone who genuinely needs a bigger tier — before the provider invoice
// says so.
//
// Everything is derived from rows that already exist, so a rollup can
// always be recomputed and nothing extra is written on the hot path.
// =============================================================================

/** What Modo Recado actually costs in call time. Used only to decide when
 *  a month looks abnormal enough to mention. */
export const EXPECTED_MONTHLY_MINUTES = 30;

/** Multiple of the expected figure that earns an operator's attention.
 *  Generous on purpose: a busy month is not a problem, and an alert that
 *  cries wolf gets filtered into a folder nobody opens. */
export const USAGE_ALERT_MULTIPLIER = 3;

export const REPORT_TEMPLATE = { name: 'recall_monthly_report', languageCode: 'es' } as const;

/** 'YYYY-MM' in the subscription's own timezone. */
export function localMonthFor(at: Date, timezone: string): string {
  return localDateFor(at, timezone).slice(0, 7);
}

/** The month before the one `at` falls in, in the same timezone. */
export function previousLocalMonth(at: Date, timezone: string): string {
  const [year, month] = localMonthFor(at, timezone).split('-').map(Number);
  return month === 1
    ? `${year - 1}-12`
    : `${year}-${String(month - 1).padStart(2, '0')}`;
}

/**
 * Is last month's report due?
 *
 * Sent on the first of the month, at the same hour the client already
 * receives his daily digest — a number he is used to reading a message
 * from at that time. `lastReportAt` is the cursor, compared by MONTH
 * rather than by instant, so a tick that runs a hundred times on the
 * first still produces one report.
 */
export function isReportDue(
  subscription: { digestHour: number; timezone: string; lastReportAt: Date | null },
  now: Date,
): boolean {
  const today = localDateFor(now, subscription.timezone);
  if (!today.endsWith('-01')) return false;
  if (localMinutesFor(now, subscription.timezone) < subscription.digestHour * 60) return false;
  if (!subscription.lastReportAt) return true;
  // Already reported this month?
  return localMonthFor(subscription.lastReportAt, subscription.timezone) < localMonthFor(now, subscription.timezone);
}

/** UTC bounds for a 'YYYY-MM' local month. Computed from the string so
 *  the window matches the label exactly; the offset is applied as a
 *  constant, which is accurate to within an hour across a DST change and
 *  far inside the tolerance of a monthly total. */
export function monthBounds(localMonth: string, timezone: string): { since: Date; until: Date } {
  const [year, month] = localMonth.split('-').map(Number);
  const utcStart = Date.UTC(year, month - 1, 1);
  const probe = new Date(utcStart);
  // How far the local clock is ahead of UTC at that moment.
  const offsetMinutes = localMinutesFor(probe, timezone) - probe.getUTCHours() * 60 - probe.getUTCMinutes();
  const since = new Date(utcStart - offsetMinutes * 60 * 1000);
  const untilUtc = month === 12 ? Date.UTC(year + 1, 0, 1) : Date.UTC(year, month, 1);
  return { since, until: new Date(untilUtc - offsetMinutes * 60 * 1000) };
}

export interface MonthlyMetrics {
  calls: number;
  recordedCalls: number;
  callSeconds: number;
  contacted: number;
  whatsappMessages: number;
  smsMessages: number;
  reviewRequests: number;
  newReviews: number;
  averageRating: number | null;
}

/**
 * Everything the report and the rollup both need, in one pass.
 *
 * Deliberately shared: two functions computing "recovered calls" from
 * their own queries is how a report and a dashboard end up disagreeing in
 * front of a client.
 */
export async function computeMonthlyMetrics(
  prisma: PrismaClient,
  subscription: { id: string; clientId: string; googleConnectionId: string | null },
  since: Date,
  until: Date,
): Promise<MonthlyMetrics> {
  const calls = await prisma.callEvent.findMany({
    where: { subscriptionId: subscription.id, startedAt: { gte: since, lt: until } },
    select: {
      outcome: true,
      recordingDurationSeconds: true,
      notifiedCallerAt: true,
      callerNotifyChannel: true,
    },
  });

  const metrics: MonthlyMetrics = {
    calls: 0,
    recordedCalls: 0,
    callSeconds: 0,
    contacted: 0,
    whatsappMessages: 0,
    smsMessages: 0,
    reviewRequests: 0,
    newReviews: 0,
    averageRating: null,
  };

  for (const call of calls) {
    // 'blocked' calls never reached the greeting; counting them as
    // recovered would inflate the one number the client checks.
    if (call.outcome === 'blocked') continue;
    metrics.calls += 1;
    if (call.outcome === 'recorded') metrics.recordedCalls += 1;
    metrics.callSeconds += call.recordingDurationSeconds ?? 0;
    if (call.notifiedCallerAt) metrics.contacted += 1;
    if (call.callerNotifyChannel === 'whatsapp') metrics.whatsappMessages += 1;
    if (call.callerNotifyChannel === 'sms') metrics.smsMessages += 1;
  }

  metrics.reviewRequests = await prisma.reviewRequest.count({
    where: {
      channel: 'whatsapp',
      status: 'sent',
      sentAt: { gte: since, lt: until },
      campaign: { clientId: subscription.clientId },
    },
  });

  if (subscription.googleConnectionId) {
    const reviews = await prisma.googleReview.findMany({
      where: {
        connectionId: subscription.googleConnectionId,
        createTime: { gte: since, lt: until },
      },
      select: { starRating: true },
    });
    metrics.newReviews = reviews.length;
    if (reviews.length > 0) {
      const total = reviews.reduce((sum, review) => sum + review.starRating, 0);
      metrics.averageRating = Math.round((total / reviews.length) * 10) / 10;
    }
  }

  return metrics;
}

// ---------------------------------------------------------------------------
// The rollup
// ---------------------------------------------------------------------------

export interface UsageRollupResult {
  scanned: number;
  updated: number;
  alerted: number;
  failed: number;
}

/**
 * Recompute this month's consumption for every live client, and flag the
 * ones that stopped looking like the others.
 *
 * Safe to run on every tick: it is an upsert of a derived figure, so
 * running it more often just makes the number fresher.
 */
export async function rollUpUsage(
  prisma: PrismaClient,
  opts: { now?: Date; limit?: number } = {},
): Promise<UsageRollupResult> {
  const now = opts.now ?? new Date();
  const result: UsageRollupResult = { scanned: 0, updated: 0, alerted: 0, failed: 0 };

  const subscriptions = await prisma.recallSubscription.findMany({
    where: { status: { in: ['active', 'paused'] } },
    take: opts.limit ?? 100,
    select: {
      id: true,
      clientId: true,
      timezone: true,
      googleConnectionId: true,
      client: { select: { name: true, companyName: true } },
    },
  });
  result.scanned = subscriptions.length;

  const recipients = resolveOperatorRecipients(process.env.KAIRIKOS_OPERATOR_EMAILS);

  for (const subscription of subscriptions) {
    try {
      const localMonth = localMonthFor(now, subscription.timezone);
      const { since, until } = monthBounds(localMonth, subscription.timezone);
      const metrics = await computeMonthlyMetrics(prisma, subscription, since, until);

      const row = await prisma.recallUsageMonth.upsert({
        where: { subscriptionId_localMonth: { subscriptionId: subscription.id, localMonth } },
        create: {
          clientId: subscription.clientId,
          subscriptionId: subscription.id,
          localMonth,
          calls: metrics.calls,
          recordedCalls: metrics.recordedCalls,
          callSeconds: metrics.callSeconds,
          whatsappMessages: metrics.whatsappMessages,
          smsMessages: metrics.smsMessages,
          reviewRequests: metrics.reviewRequests,
          computedAt: now,
        },
        update: {
          calls: metrics.calls,
          recordedCalls: metrics.recordedCalls,
          callSeconds: metrics.callSeconds,
          whatsappMessages: metrics.whatsappMessages,
          smsMessages: metrics.smsMessages,
          reviewRequests: metrics.reviewRequests,
          computedAt: now,
        },
        select: { id: true, alertedAt: true },
      });
      result.updated += 1;

      const minutes = Math.round(metrics.callSeconds / 60);
      const threshold = EXPECTED_MONTHLY_MINUTES * USAGE_ALERT_MULTIPLIER;
      if (minutes < threshold || row.alertedAt || recipients.length === 0) continue;

      const rendered = renderUsageSpike({
        clientId: subscription.clientId,
        clientName: subscription.client.companyName ?? subscription.client.name,
        localMonth,
        minutes,
        expectedMinutes: EXPECTED_MONTHLY_MINUTES,
        calls: metrics.calls,
      });
      const sent = await sendOperatorNotification({
        kind: 'usage-spike',
        to: recipients,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      });
      if (!sent.ok) continue;

      // Stamped only after a successful send, so a mail outage delays the
      // warning rather than consuming the single one this month gets.
      await prisma.recallUsageMonth.update({ where: { id: row.id }, data: { alertedAt: now } });
      result.alerted += 1;
    } catch (err) {
      result.failed += 1;
      logError('recall_reports.rollup_failed', err, { subscriptionId: subscription.id }, 'warn');
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface ReportSweepResult {
  scanned: number;
  sent: number;
  skippedEmpty: number;
  failed: number;
}

/**
 * Send each client last month's numbers.
 *
 * A month with ZERO recovered calls does not produce a client message. In
 * practice that almost always means the call divert stopped working
 * rather than that the client missed no calls, so the useful action is an
 * operator looking at it — not a report that reads like a refund request.
 * The cursor still advances, so the month is not retried forever.
 */
export async function sendMonthlyReports(
  prisma: PrismaClient,
  opts: { now?: Date; limit?: number } = {},
): Promise<ReportSweepResult> {
  const now = opts.now ?? new Date();
  const result: ReportSweepResult = { scanned: 0, sent: 0, skippedEmpty: 0, failed: 0 };

  const subscriptions = await prisma.recallSubscription.findMany({
    where: { status: 'active', ownerWhatsapp: { not: null } },
    take: opts.limit ?? 50,
    select: {
      id: true,
      clientId: true,
      timezone: true,
      digestHour: true,
      lastReportAt: true,
      ownerWhatsapp: true,
      googleConnectionId: true,
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
    },
  });

  for (const subscription of subscriptions) {
    try {
      if (!isReportDue(subscription, now)) continue;
      result.scanned += 1;

      const localMonth = previousLocalMonth(now, subscription.timezone);
      const { since, until } = monthBounds(localMonth, subscription.timezone);
      const metrics = await computeMonthlyMetrics(prisma, subscription, since, until);

      if (metrics.calls === 0) {
        // Advance the cursor anyway: a month with nothing in it must not
        // be reconsidered on every tick for the next thirty days.
        await prisma.recallSubscription.update({
          where: { id: subscription.id },
          data: { lastReportAt: now },
        });
        result.skippedEmpty += 1;
        continue;
      }

      const sender = metaSenderFor(subscription.metaConnection);
      if (!sender || !subscription.ownerWhatsapp) {
        result.failed += 1;
        continue;
      }

      const sent = await sendTemplate(sender.token, sender.phoneNumberId, subscription.ownerWhatsapp, {
        ...REPORT_TEMPLATE,
        bodyParams: [
          monthLabel(localMonth),
          String(metrics.calls),
          String(metrics.contacted),
          String(metrics.newReviews),
          metrics.averageRating === null ? 'sin datos' : metrics.averageRating.toFixed(1),
        ],
      });
      if (!sent.ok) {
        // Cursor NOT advanced: the next tick retries, and the client gets
        // his month rather than silently losing it.
        result.failed += 1;
        continue;
      }

      await prisma.recallSubscription.update({
        where: { id: subscription.id },
        data: { lastReportAt: now },
      });
      result.sent += 1;
    } catch (err) {
      result.failed += 1;
      logError('recall_reports.report_failed', err, { subscriptionId: subscription.id }, 'warn');
    }
  }

  return result;
}

const MONTH_NAMES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/** 'julio' rather than '2026-07'. The report is read on a phone by
 *  someone who is not looking at a dashboard. */
export function monthLabel(localMonth: string): string {
  const [, month] = localMonth.split('-').map(Number);
  return MONTH_NAMES[month - 1] ?? localMonth;
}
