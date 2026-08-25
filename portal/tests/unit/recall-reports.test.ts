// =============================================================================
// WP-XX (Fase 11) — unit tests for the monthly report and the metering.
//
// The report is the retention mechanism: a client who cannot see what he
// got cancels in month two. So the failures that matter are the quiet
// ones — a month boundary off by an hour that drops the last calls of the
// month, a cursor that lets the same report go out twice, and a failed
// send that advances the cursor and loses the month entirely.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const mockState = vi.hoisted(() => ({
  sendTemplate: vi.fn(),
  metaSenderFor: vi.fn(),
  sendOperatorNotification: vi.fn(),
  resolveOperatorRecipients: vi.fn(),
}));

vi.mock('@/lib/whatsapp-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/whatsapp-api')>('@/lib/whatsapp-api');
  return { ...actual, sendTemplate: (...a: unknown[]) => mockState.sendTemplate(...a) };
});
vi.mock('@/lib/recall-messaging', () => ({
  metaSenderFor: (...a: unknown[]) => mockState.metaSenderFor(...a),
}));
vi.mock('@/lib/operator-notify', async () => {
  const actual = await vi.importActual<typeof import('@/lib/operator-notify')>('@/lib/operator-notify');
  return {
    ...actual,
    sendOperatorNotification: (...a: unknown[]) => mockState.sendOperatorNotification(...a),
    resolveOperatorRecipients: (...a: unknown[]) => mockState.resolveOperatorRecipients(...a),
  };
});

import {
  localMonthFor,
  previousLocalMonth,
  shiftLocalMonth,
  monthBounds,
  monthLabel,
  isReportDue,
  computeMonthlyMetrics,
  rollUpUsage,
  sendMonthlyReports,
  EXPECTED_MONTHLY_MINUTES,
  USAGE_ALERT_MULTIPLIER,
} from '@/lib/recall-reports';

const MADRID = 'Europe/Madrid';

const state = {
  subFindMany: vi.fn(),
  subUpdate: vi.fn(),
  callFindMany: vi.fn(),
  reviewRequestCount: vi.fn(),
  googleReviewFindMany: vi.fn(),
  usageUpsert: vi.fn(),
  usageUpdate: vi.fn(),
};

const prisma = {
  recallSubscription: {
    findMany: (...a: unknown[]) => state.subFindMany(...a),
    update: (...a: unknown[]) => state.subUpdate(...a),
  },
  callEvent: { findMany: (...a: unknown[]) => state.callFindMany(...a) },
  reviewRequest: { count: (...a: unknown[]) => state.reviewRequestCount(...a) },
  googleReview: { findMany: (...a: unknown[]) => state.googleReviewFindMany(...a) },
  recallUsageMonth: {
    upsert: (...a: unknown[]) => state.usageUpsert(...a),
    update: (...a: unknown[]) => state.usageUpdate(...a),
  },
} as unknown as PrismaClient;

const CONNECTION = {
  id: 'conn_1',
  externalId: 'phone_1',
  status: 'active',
  accessTokenCiphertext: Buffer.from('c'),
  accessTokenIv: Buffer.from('i'),
  accessTokenTag: Buffer.from('t'),
};

/** 1 August 2026, 19:10 Madrid — the first of the month, after the
 *  digest hour, so last month's report is due. */
const FIRST_OF_MONTH = new Date('2026-08-01T17:10:00.000Z');

beforeEach(() => {
  for (const fn of Object.values(state)) fn.mockReset();
  mockState.sendTemplate.mockReset().mockResolvedValue({ ok: true, data: { messages: [{ id: 'wamid.1' }] } });
  mockState.metaSenderFor.mockReset().mockReturnValue({ token: 'tok', phoneNumberId: 'phone_1' });
  mockState.sendOperatorNotification.mockReset().mockResolvedValue({ ok: true, messageId: 'm1' });
  mockState.resolveOperatorRecipients.mockReset().mockReturnValue([{ email: 'ops@kairikos.com' }]);

  state.subFindMany.mockResolvedValue([]);
  state.subUpdate.mockResolvedValue({});
  state.callFindMany.mockResolvedValue([]);
  state.reviewRequestCount.mockResolvedValue(0);
  state.googleReviewFindMany.mockResolvedValue([]);
  state.usageUpsert.mockResolvedValue({ id: 'usage_1', alertedAt: null });
  state.usageUpdate.mockResolvedValue({});
});

describe('month arithmetic', () => {
  it('reads the month in the client timezone, not UTC', () => {
    // 22:30 UTC on 31 July is already 00:30 on 1 August in Madrid.
    const at = new Date('2026-07-31T22:30:00.000Z');
    expect(localMonthFor(at, MADRID)).toBe('2026-08');
    expect(localMonthFor(at, 'UTC')).toBe('2026-07');
  });

  it('steps back a month, including across a year boundary', () => {
    expect(previousLocalMonth(new Date('2026-08-15T12:00:00.000Z'), MADRID)).toBe('2026-07');
    expect(previousLocalMonth(new Date('2026-01-15T12:00:00.000Z'), MADRID)).toBe('2025-12');
    // March back to February, the month most likely to be got wrong.
    expect(previousLocalMonth(new Date('2026-03-15T12:00:00.000Z'), MADRID)).toBe('2026-02');
  });

  it('bounds a month so its own local dates fall inside and its neighbours do not', () => {
    const { since, until } = monthBounds('2026-07', MADRID);
    // The first minute of July in Madrid is 30 June 22:00 UTC.
    expect(localMonthFor(since, MADRID)).toBe('2026-07');
    expect(since.getTime()).toBeLessThan(new Date('2026-07-01T00:00:00.000Z').getTime());
    // `until` is exclusive, so it is the first instant of August.
    expect(localMonthFor(until, MADRID)).toBe('2026-08');
    // A call at 23:30 on 31 July local must fall INSIDE July — this is
    // the boundary that silently drops a client's last calls.
    const lateJuly = new Date('2026-07-31T21:30:00.000Z');
    expect(lateJuly.getTime()).toBeGreaterThanOrEqual(since.getTime());
    expect(lateJuly.getTime()).toBeLessThan(until.getTime());
  });

  it('bounds December so the year rolls over', () => {
    const { since, until } = monthBounds('2026-12', MADRID);
    expect(localMonthFor(since, MADRID)).toBe('2026-12');
    expect(localMonthFor(until, MADRID)).toBe('2027-01');
  });

  it('names the month in Spanish, because it is read on a phone', () => {
    expect(monthLabel('2026-07')).toBe('julio');
    expect(monthLabel('2026-12')).toBe('diciembre');
  });
});

describe('isReportDue', () => {
  const sub = (over: Record<string, unknown> = {}) => ({
    digestHour: 19,
    timezone: MADRID,
    lastReportAt: null,
    ...over,
  });

  it('is due on the first, once the digest hour has passed', () => {
    expect(isReportDue(sub(), FIRST_OF_MONTH)).toBe(true);
  });

  it('is not due earlier in the day', () => {
    expect(isReportDue(sub(), new Date('2026-08-01T09:00:00.000Z'))).toBe(false);
  });

  it('is not due on any other day of the month', () => {
    expect(isReportDue(sub(), new Date('2026-08-02T17:10:00.000Z'))).toBe(false);
    expect(isReportDue(sub(), new Date('2026-08-31T17:10:00.000Z'))).toBe(false);
  });

  it('does not send twice, however many ticks run on the first', () => {
    // The cursor is compared by MONTH, not by instant, so a hundred ticks
    // on the first still produce one report.
    const already = sub({ lastReportAt: new Date('2026-08-01T17:05:00.000Z') });
    expect(isReportDue(already, FIRST_OF_MONTH)).toBe(false);
  });

  it('is due again the following month', () => {
    const lastMonth = sub({ lastReportAt: new Date('2026-07-01T17:05:00.000Z') });
    expect(isReportDue(lastMonth, FIRST_OF_MONTH)).toBe(true);
  });
});

describe('computeMonthlyMetrics', () => {
  const subscription = { id: 'sub_1', clientId: 'client_1', googleConnectionId: 'gbc_1' };
  const bounds = monthBounds('2026-07', MADRID);

  it('counts recovered calls, contacts and seconds in one pass', async () => {
    state.callFindMany.mockResolvedValue([
      { outcome: 'recorded', recordingDurationSeconds: 30, notifiedCallerAt: new Date(), callerNotifyChannel: 'whatsapp' },
      { outcome: 'recorded', recordingDurationSeconds: 45, notifiedCallerAt: new Date(), callerNotifyChannel: 'sms' },
      { outcome: 'no_message', recordingDurationSeconds: null, notifiedCallerAt: null, callerNotifyChannel: 'throttled' },
    ]);

    const metrics = await computeMonthlyMetrics(prisma, subscription, bounds.since, bounds.until);
    expect(metrics).toMatchObject({
      calls: 3,
      recordedCalls: 2,
      callSeconds: 75,
      contacted: 2,
      whatsappMessages: 1,
      smsMessages: 1,
    });
  });

  it('excludes blocked calls from the headline number', async () => {
    // Counting a sales robot as a recovered call would inflate the one
    // figure the client actually checks.
    state.callFindMany.mockResolvedValue([
      { outcome: 'recorded', recordingDurationSeconds: 20, notifiedCallerAt: null, callerNotifyChannel: null },
      { outcome: 'blocked', recordingDurationSeconds: null, notifiedCallerAt: null, callerNotifyChannel: 'blocked' },
    ]);

    const metrics = await computeMonthlyMetrics(prisma, subscription, bounds.since, bounds.until);
    expect(metrics.calls).toBe(1);
  });

  it('averages the ratings of reviews that arrived in the month', async () => {
    state.googleReviewFindMany.mockResolvedValue([{ starRating: 5 }, { starRating: 4 }, { starRating: 5 }]);
    const metrics = await computeMonthlyMetrics(prisma, subscription, bounds.since, bounds.until);
    expect(metrics.newReviews).toBe(3);
    expect(metrics.averageRating).toBe(4.7);
  });

  it('reports no rating rather than zero when nothing arrived', async () => {
    // A zero would read as "you scored 0", which is the opposite of true.
    const metrics = await computeMonthlyMetrics(prisma, subscription, bounds.since, bounds.until);
    expect(metrics.newReviews).toBe(0);
    expect(metrics.averageRating).toBeNull();
  });

  it('skips the review half entirely when Google is not connected', async () => {
    await computeMonthlyMetrics(
      prisma,
      { ...subscription, googleConnectionId: null },
      bounds.since,
      bounds.until,
    );
    expect(state.googleReviewFindMany).not.toHaveBeenCalled();
  });
});

describe('sendMonthlyReports', () => {
  const subscription = (over: Record<string, unknown> = {}) => ({
    id: 'sub_1',
    clientId: 'client_1',
    timezone: MADRID,
    digestHour: 19,
    lastReportAt: null,
    ownerWhatsapp: '+34600111222',
    googleConnectionId: 'gbc_1',
    metaConnection: CONNECTION,
    ...over,
  });

  it("sends last month's numbers and advances the cursor", async () => {
    state.subFindMany.mockResolvedValue([subscription()]);
    state.callFindMany.mockResolvedValue([
      { outcome: 'recorded', recordingDurationSeconds: 40, notifiedCallerAt: new Date(), callerNotifyChannel: 'whatsapp' },
    ]);
    state.googleReviewFindMany.mockResolvedValue([{ starRating: 5 }]);

    await expect(sendMonthlyReports(prisma, { now: FIRST_OF_MONTH })).resolves.toMatchObject({ sent: 1 });

    const template = mockState.sendTemplate.mock.calls[0][3];
    // Named month, recovered, contacted, new reviews, rating.
    expect(template.bodyParams).toEqual(['julio', '1', '1', '1', '5.0']);
    expect(state.subUpdate.mock.calls[0][0].data.lastReportAt).toBe(FIRST_OF_MONTH);
  });

  it('says "sin datos" rather than a rating of zero', async () => {
    state.subFindMany.mockResolvedValue([subscription()]);
    state.callFindMany.mockResolvedValue([
      { outcome: 'recorded', recordingDurationSeconds: 10, notifiedCallerAt: null, callerNotifyChannel: null },
    ]);

    await sendMonthlyReports(prisma, { now: FIRST_OF_MONTH });
    expect(mockState.sendTemplate.mock.calls[0][3].bodyParams[4]).toBe('sin datos');
  });

  it('stays silent on an empty month, but still advances the cursor', async () => {
    // Zero recovered calls almost always means the divert broke, not that
    // the client missed nothing — a report there reads like a refund
    // request. The cursor moves so it is not reconsidered for 30 days.
    state.subFindMany.mockResolvedValue([subscription()]);
    state.callFindMany.mockResolvedValue([]);

    await expect(sendMonthlyReports(prisma, { now: FIRST_OF_MONTH })).resolves.toMatchObject({
      skippedEmpty: 1,
      sent: 0,
    });
    expect(mockState.sendTemplate).not.toHaveBeenCalled();
    expect(state.subUpdate.mock.calls[0][0].data.lastReportAt).toBe(FIRST_OF_MONTH);
  });

  it('does NOT advance the cursor when the send failed', async () => {
    state.subFindMany.mockResolvedValue([subscription()]);
    state.callFindMany.mockResolvedValue([
      { outcome: 'recorded', recordingDurationSeconds: 10, notifiedCallerAt: null, callerNotifyChannel: null },
    ]);
    mockState.sendTemplate.mockResolvedValue({ ok: false, error: 'rate limited', code: 131056 });

    await expect(sendMonthlyReports(prisma, { now: FIRST_OF_MONTH })).resolves.toMatchObject({ failed: 1 });
    // Advancing here would lose the client's month silently and forever.
    expect(state.subUpdate).not.toHaveBeenCalled();
  });

  it('does nothing on a day that is not the first', async () => {
    state.subFindMany.mockResolvedValue([subscription()]);
    await expect(sendMonthlyReports(prisma, { now: new Date('2026-08-15T17:10:00.000Z') })).resolves.toMatchObject({
      scanned: 0,
      sent: 0,
    });
  });

  it('lets one bad client fail without costing the others their report', async () => {
    state.subFindMany.mockResolvedValue([subscription({ id: 'bad' }), subscription()]);
    state.callFindMany.mockImplementation(async ({ where }: { where: { subscriptionId: string } }) => {
      if (where.subscriptionId === 'bad') throw new Error('db blip');
      return [{ outcome: 'recorded', recordingDurationSeconds: 10, notifiedCallerAt: null, callerNotifyChannel: null }];
    });

    const result = await sendMonthlyReports(prisma, { now: FIRST_OF_MONTH });
    expect(result.failed).toBe(1);
    expect(result.sent).toBe(1);
  });
});

describe('rollUpUsage', () => {
  const subscription = (over: Record<string, unknown> = {}) => ({
    id: 'sub_1',
    clientId: 'client_1',
    timezone: MADRID,
    googleConnectionId: null,
    client: { name: 'Juan', companyName: 'Fontanería Aurora' },
    ...over,
  });

  const busyMonth = (minutes: number) => [
    {
      outcome: 'recorded',
      recordingDurationSeconds: minutes * 60,
      notifiedCallerAt: new Date(),
      callerNotifyChannel: 'whatsapp',
    },
  ];

  it('includes paused clients, whose consumption still lands on our invoice', async () => {
    await rollUpUsage(prisma, { now: FIRST_OF_MONTH });
    expect(state.subFindMany.mock.calls[0][0].where.status).toEqual({ in: ['active', 'paused'] });
  });

  it('upserts the month, so running it every tick just makes it fresher', async () => {
    state.subFindMany.mockResolvedValue([subscription()]);
    state.callFindMany.mockResolvedValue(busyMonth(2));

    await expect(rollUpUsage(prisma, { now: FIRST_OF_MONTH })).resolves.toMatchObject({ updated: 1 });
    expect(state.usageUpsert.mock.calls[0][0].where).toEqual({
      subscriptionId_localMonth: { subscriptionId: 'sub_1', localMonth: '2026-08' },
    });
    expect(state.usageUpsert.mock.calls[0][0].update.callSeconds).toBe(120);
  });

  it('says nothing about an ordinary month', async () => {
    state.subFindMany.mockResolvedValue([subscription()]);
    state.callFindMany.mockResolvedValue(busyMonth(EXPECTED_MONTHLY_MINUTES));

    await expect(rollUpUsage(prisma, { now: FIRST_OF_MONTH })).resolves.toMatchObject({ alerted: 0 });
    expect(mockState.sendOperatorNotification).not.toHaveBeenCalled();
  });

  it('warns an operator once a month stops resembling the others', async () => {
    state.subFindMany.mockResolvedValue([subscription()]);
    state.callFindMany.mockResolvedValue(busyMonth(EXPECTED_MONTHLY_MINUTES * USAGE_ALERT_MULTIPLIER + 5));

    await expect(rollUpUsage(prisma, { now: FIRST_OF_MONTH })).resolves.toMatchObject({ alerted: 1 });
    const notification = mockState.sendOperatorNotification.mock.calls[0][0];
    // Its own kind: sharing 'stuck' would let one alert silence the other
    // for that client that day.
    expect(notification.kind).toBe('usage-spike');
    expect(notification.subject).toContain('Fontanería Aurora');
    expect(state.usageUpdate.mock.calls[0][0].data).toEqual({ alertedAt: FIRST_OF_MONTH });
  });

  it('warns once per month, not once per tick', async () => {
    state.subFindMany.mockResolvedValue([subscription()]);
    state.callFindMany.mockResolvedValue(busyMonth(200));
    state.usageUpsert.mockResolvedValue({ id: 'usage_1', alertedAt: new Date('2026-08-01T10:00:00.000Z') });

    await expect(rollUpUsage(prisma, { now: FIRST_OF_MONTH })).resolves.toMatchObject({ alerted: 0 });
    expect(mockState.sendOperatorNotification).not.toHaveBeenCalled();
  });

  it('does not consume the warning when the mail fails', async () => {
    state.subFindMany.mockResolvedValue([subscription()]);
    state.callFindMany.mockResolvedValue(busyMonth(200));
    mockState.sendOperatorNotification.mockResolvedValue({ ok: false, error: 'resend down' });

    await expect(rollUpUsage(prisma, { now: FIRST_OF_MONTH })).resolves.toMatchObject({ alerted: 0 });
    expect(state.usageUpdate).not.toHaveBeenCalled();
  });

  it('still records usage when no operator recipients are configured', async () => {
    state.subFindMany.mockResolvedValue([subscription()]);
    state.callFindMany.mockResolvedValue(busyMonth(200));
    mockState.resolveOperatorRecipients.mockReturnValue([]);

    await expect(rollUpUsage(prisma, { now: FIRST_OF_MONTH })).resolves.toMatchObject({ updated: 1, alerted: 0 });
  });
});

// =============================================================================
// WP-XX — month arithmetic on the 'YYYY-MM' key itself, added for the
// client page's month navigation. String arithmetic on purpose: a month
// key is a calendar label, and a Date would drag a timezone into a
// question that has none.
// =============================================================================

describe('shiftLocalMonth', () => {
  it('moves whole months in both directions', () => {
    expect(shiftLocalMonth('2026-07', -1)).toBe('2026-06');
    expect(shiftLocalMonth('2026-07', 1)).toBe('2026-08');
    expect(shiftLocalMonth('2026-07', 0)).toBe('2026-07');
  });

  it('rolls the year over at both boundaries', () => {
    expect(shiftLocalMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftLocalMonth('2026-12', 1)).toBe('2027-01');
  });

  it('handles a jump of more than a year', () => {
    expect(shiftLocalMonth('2026-03', -14)).toBe('2025-01');
    expect(shiftLocalMonth('2026-03', 24)).toBe('2028-03');
  });

  it('keeps producing keys that sort as dates', () => {
    // The whole navigation compares these with < and >, so a lost zero
    // would silently reorder the client's months.
    expect(shiftLocalMonth('2026-10', 1)).toBe('2026-11');
    expect(shiftLocalMonth('2026-09', 1)).toBe('2026-10');
    expect(shiftLocalMonth('2026-10', -2)).toBe('2026-08');
    expect(shiftLocalMonth('2026-01', 0) < shiftLocalMonth('2026-02', 0)).toBe(true);
  });

  it('agrees with previousLocalMonth, which is now built on it', () => {
    expect(shiftLocalMonth(localMonthFor(new Date('2026-01-15T12:00:00.000Z'), MADRID), -1)).toBe(
      previousLocalMonth(new Date('2026-01-15T12:00:00.000Z'), MADRID),
    );
  });
});
