// =============================================================================
// WP-XX — unit tests for the client's own view of the 'recall' service.
//
// Two properties carry the weight. It must be READ-ONLY, because the
// digest reply is the single writer of "which calls became a job" and a
// second one would let them disagree. And it must be SCOPED TO THE
// SESSION CLIENT at every step — this is the only place recall data is
// read on behalf of an end client rather than an operator.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const mockState = vi.hoisted(() => ({ computeMonthlyMetrics: vi.fn() }));

vi.mock('@/lib/recall-reports', async () => {
  const actual = await vi.importActual<typeof import('@/lib/recall-reports')>('@/lib/recall-reports');
  return { ...actual, computeMonthlyMetrics: (...a: unknown[]) => mockState.computeMonthlyMetrics(...a) };
});

import {
  loadRecallClientView,
  buildHistory,
  clampMonth,
  clampPage,
  HISTORY_MONTHS,
  CALLS_PER_PAGE,
} from '@/lib/recall-client-view';
import { RECORDING_RETENTION_DAYS } from '@/lib/recall-retention';

const state = {
  subFindFirst: vi.fn(),
  usageFindMany: vi.fn(),
  usageFindFirst: vi.fn(),
  callFindMany: vi.fn(),
  callCount: vi.fn(),
};

const prisma = {
  recallSubscription: { findFirst: (...a: unknown[]) => state.subFindFirst(...a) },
  recallUsageMonth: {
    findMany: (...a: unknown[]) => state.usageFindMany(...a),
    findFirst: (...a: unknown[]) => state.usageFindFirst(...a),
  },
  callEvent: {
    findMany: (...a: unknown[]) => state.callFindMany(...a),
    count: (...a: unknown[]) => state.callCount(...a),
  },
} as unknown as PrismaClient;

// 15 July 2026, 12:00 Madrid.
const NOW = new Date('2026-07-15T10:00:00.000Z');

const METRICS = {
  calls: 7,
  recordedCalls: 5,
  callSeconds: 300,
  contacted: 6,
  whatsappMessages: 5,
  smsMessages: 1,
  reviewRequests: 3,
  newReviews: 2,
  averageRating: 4.5,
};

function subscription(over: Record<string, unknown> = {}) {
  return {
    id: 'sub_1',
    clientId: 'client_1',
    status: 'active',
    createdAt: new Date('2026-06-01T09:00:00.000Z'),
    activatedAt: new Date('2026-06-05T09:00:00.000Z'),
    timezone: 'Europe/Madrid',
    googleConnectionId: 'gbc_1',
    virtualNumber: { e164: '+34910555123' },
    ...over,
  };
}

beforeEach(() => {
  for (const fn of Object.values(state)) fn.mockReset();
  mockState.computeMonthlyMetrics.mockReset().mockResolvedValue(METRICS);
  state.subFindFirst.mockResolvedValue(null);
  state.usageFindMany.mockResolvedValue([]);
  // No roll-up rows by default: the range floor becomes the current month.
  state.usageFindFirst.mockResolvedValue(null);
  state.callFindMany.mockResolvedValue([]);
  state.callCount.mockResolvedValue(0);
});

const load = () => loadRecallClientView(prisma, 'client_1', { now: NOW });

describe('loadRecallClientView — access', () => {
  it('shows the pitch when the client has no subscription', async () => {
    await expect(load()).resolves.toEqual({ state: 'not_contracted' });
    expect(state.callFindMany).not.toHaveBeenCalled();
  });

  it('scopes every read to the session client', async () => {
    state.subFindFirst.mockResolvedValue(subscription());
    await load();
    // Nothing here may take an id from anywhere but the session.
    expect(state.subFindFirst.mock.calls[0][0].where).toEqual({ clientId: 'client_1' });
    expect(state.usageFindMany.mock.calls[0][0].where).toMatchObject({ subscriptionId: 'sub_1' });
    expect(state.callFindMany.mock.calls[0][0].where.subscriptionId).toBe('sub_1');
    expect(state.usageFindFirst.mock.calls[0][0].where).toEqual({ subscriptionId: 'sub_1' });
  });

  it('explains itself rather than showing an empty dashboard while onboarding', async () => {
    state.subFindFirst.mockResolvedValue(subscription({ status: 'forwarding_pending', activatedAt: null }));

    await expect(load()).resolves.toEqual({
      state: 'onboarding',
      status: 'forwarding_pending',
      since: new Date('2026-06-01T09:00:00.000Z'),
      virtualNumber: '+34910555123',
      metaConnection: null,
    });
    // An empty dashboard here would read as "we sold you nothing".
    expect(mockState.computeMonthlyMetrics).not.toHaveBeenCalled();
  });

  it('Fase 8 — surfaces the bound Coexistence connection once one exists', async () => {
    state.subFindFirst.mockResolvedValue(
      subscription({ status: 'number_assigned', metaConnection: { displayPhoneNumber: '+34 611 22 33 44' } }),
    );
    await expect(load()).resolves.toMatchObject({
      state: 'onboarding',
      metaConnection: { displayPhoneNumber: '+34 611 22 33 44' },
    });
  });

  it('treats paused and cancelled the same way — the client should see why', async () => {
    for (const status of ['paused', 'cancelled']) {
      state.subFindFirst.mockResolvedValue(subscription({ status }));
      const view = await load();
      expect(view).toMatchObject({ state: 'onboarding', status });
    }
  });
});

describe('loadRecallClientView — active', () => {
  beforeEach(() => {
    state.subFindFirst.mockResolvedValue(subscription());
  });

  it('reports the SAME numbers the WhatsApp report uses', async () => {
    const view = await load();
    // Recomputing them here would let the portal and the message he
    // already received disagree in front of him.
    expect(view).toMatchObject({ state: 'active', metrics: METRICS, localMonth: '2026-07' });
    expect(mockState.computeMonthlyMetrics).toHaveBeenCalledTimes(1);
  });

  it('reads the month in the client timezone', async () => {
    // 22:30 UTC on 31 July is already August in Madrid.
    const view = await loadRecallClientView(prisma, 'client_1', {
      now: new Date('2026-07-31T22:30:00.000Z'),
    });
    expect(view).toMatchObject({ localMonth: '2026-08' });
  });

  it('turns stored seconds into minutes for the months it did not compute', async () => {
    state.usageFindMany.mockResolvedValue([
      { localMonth: '2026-06', calls: 4, recordedCalls: 2, callSeconds: 60, reviewRequests: 1 },
    ]);

    const view = await load();
    expect((view as { history: unknown[] }).history[1]).toEqual({
      localMonth: '2026-06',
      calls: 4,
      recordedCalls: 2,
      minutes: 1,
      reviewRequests: 1,
      isSelected: false,
    });
  });

  it('shows the newest months first, bounded to a year', async () => {
    await load();
    const query = state.usageFindMany.mock.calls[0][0];
    expect(query.orderBy).toEqual({ localMonth: 'desc' });
    expect(query.take).toBe(HISTORY_MONTHS);
  });

  it('keeps every month in the table, including the one on screen', async () => {
    await load();
    // The table IS the navigation. Dropping its selected row would
    // reshuffle the list every time the reader used it.
    expect(state.usageFindMany.mock.calls[0][0].where).toEqual({ subscriptionId: 'sub_1' });
  });

  it('hides calls the client asked us to block', async () => {
    await load();
    // Listing them back is noise about a decision he already made.
    expect(state.callFindMany.mock.calls[0][0].where.outcome).toEqual({ not: 'blocked' });
  });

  it('fetches one page of that month, newest first, inside its window', async () => {
    await load();
    const query = state.callFindMany.mock.calls[0][0];
    expect(query.orderBy).toEqual({ startedAt: 'desc' });
    expect(query.take).toBe(CALLS_PER_PAGE);
    expect(query.skip).toBe(0);
    expect(query.where.startedAt.gte).toBeInstanceOf(Date);
    expect(query.where.startedAt.lt).toBeInstanceOf(Date);
  });

  it('never selects anything that could be written back', async () => {
    await load();
    const select = state.callFindMany.mock.calls[0][0].select;
    // The page is read-only by construction: it does not even read the
    // fields a second writer would need.
    expect(select.leadId).toBeUndefined();
    expect(select.recordingUrl).toBeUndefined();
    expect(select.recordingSid).toBeUndefined();
  });

  it('reports the retention the purge job actually enforces, not a literal', async () => {
    const view = await load();
    expect(view).toMatchObject({ recordingRetentionDays: RECORDING_RETENTION_DAYS });
  });

  it('survives a subscription with no number assigned yet', async () => {
    state.subFindFirst.mockResolvedValue(subscription({ virtualNumber: null }));
    await expect(load()).resolves.toMatchObject({ state: 'active', virtualNumber: null });
  });
});

describe('clampMonth', () => {
  it('accepts a well-formed month inside the range', () => {
    expect(clampMonth('2026-05', '2026-01', '2026-07')).toBe('2026-05');
  });

  it('falls back to the newest month for anything unparseable', () => {
    // A URL is user input. An empty page would read as "you had no
    // calls" when it really means "that month never existed".
    for (const bad of [null, undefined, '', 'julio', '2026-13', '2026-00', '26-07', '2026-7', 'DROP TABLE']) {
      expect(clampMonth(bad, '2026-01', '2026-07')).toBe('2026-07');
    }
  });

  it('clamps to the ends rather than rendering an empty month', () => {
    expect(clampMonth('2019-01', '2026-01', '2026-07')).toBe('2026-01');
    expect(clampMonth('2099-01', '2026-01', '2026-07')).toBe('2026-07');
  });
});

describe('loadRecallClientView — month navigation', () => {
  beforeEach(() => {
    state.subFindFirst.mockResolvedValue(subscription());
    state.usageFindFirst.mockResolvedValue({ localMonth: '2026-04' });
  });

  it('defaults to the current month, with no way forward from it', async () => {
    const view = await load();
    expect(view).toMatchObject({ localMonth: '2026-07', previousMonth: '2026-06', nextMonth: null });
  });

  it('walks backwards and forwards between the ends', async () => {
    const may = await loadRecallClientView(prisma, 'client_1', { now: NOW, month: '2026-05' });
    expect(may).toMatchObject({ localMonth: '2026-05', previousMonth: '2026-04', nextMonth: '2026-06' });
  });

  it('stops at the earliest month that has data', async () => {
    const april = await loadRecallClientView(prisma, 'client_1', { now: NOW, month: '2026-04' });
    // Without a floor the arrow would walk backwards forever through
    // months that never existed.
    expect(april).toMatchObject({ localMonth: '2026-04', previousMonth: null });
  });

  it('offers no navigation at all when there is only this month', async () => {
    state.usageFindFirst.mockResolvedValue(null);
    const view = await load();
    expect(view).toMatchObject({ localMonth: '2026-07', previousMonth: null, nextMonth: null });
  });

  it('ignores a roll-up row from the future rather than trusting it as a floor', async () => {
    state.usageFindFirst.mockResolvedValue({ localMonth: '2027-01' });
    const view = await load();
    expect(view).toMatchObject({ localMonth: '2026-07', previousMonth: null });
  });

  it('computes a PAST month the same way as the current one', async () => {
    await loadRecallClientView(prisma, 'client_1', { now: NOW, month: '2026-05' });
    // Same function as the WhatsApp report, whichever month is shown.
    expect(mockState.computeMonthlyMetrics).toHaveBeenCalledTimes(1);
  });
});

describe('buildHistory', () => {
  const rows = [
    { localMonth: '2026-06', calls: 4, recordedCalls: 2, callSeconds: 120, reviewRequests: 1 },
    { localMonth: '2026-05', calls: 9, recordedCalls: 7, callSeconds: 600, reviewRequests: 5 },
  ];
  const live = { calls: 12, recordedCalls: 8, callSeconds: 305, reviewRequests: 6 };

  it('never drops the selected month', () => {
    const out = buildHistory(rows, '2026-07', live);
    expect(out.map((r) => r.localMonth)).toEqual(['2026-07', '2026-06', '2026-05']);
  });

  it('gives the selected month the LIVE figures, so it cannot disagree with the summary', () => {
    const out = buildHistory(rows, '2026-06', live);
    const june = out.find((r) => r.localMonth === '2026-06');
    // The stored row said 4 calls; the summary above says 12. Showing
    // the stored one here would print two numbers for one month.
    expect(june).toEqual({
      localMonth: '2026-06',
      calls: 12,
      recordedCalls: 8,
      minutes: 5,
      reviewRequests: 6,
      isSelected: true,
    });
  });

  it('marks exactly one row as selected', () => {
    const out = buildHistory(rows, '2026-05', live);
    expect(out.filter((r) => r.isSelected)).toHaveLength(1);
  });

  it('sorts newest first whichever month is selected', () => {
    expect(buildHistory(rows, '2026-05', live).map((r) => r.localMonth)).toEqual([
      '2026-06',
      '2026-05',
    ]);
    expect(buildHistory(rows, '2026-12', live).map((r) => r.localMonth)).toEqual([
      '2026-12',
      '2026-06',
      '2026-05',
    ]);
  });

  it('synthesises the selected month when no roll-up row exists yet', () => {
    // The normal state of a month that started this morning.
    const out = buildHistory([], '2026-07', live);
    expect(out).toEqual([{ localMonth: '2026-07', calls: 12, recordedCalls: 8, minutes: 5, reviewRequests: 6, isSelected: true }]);
  });
});

describe('clampPage', () => {
  it('accepts a page inside the range', () => {
    expect(clampPage(3, 6)).toBe(3);
    expect(clampPage('3', 6)).toBe(3);
  });

  it('falls back to the first page for anything unparseable', () => {
    for (const bad of [null, undefined, '', 'abc', '-4', '0', Number.NaN]) {
      expect(clampPage(bad, 6)).toBe(1);
    }
  });

  it('clamps past the end rather than rendering an empty list', () => {
    // ?p=99 on a two-page month must land on page two, not on a page
    // that would read as "you had no calls".
    expect(clampPage(99, 2)).toBe(2);
  });

  it('always yields at least page 1, even with nothing to show', () => {
    expect(clampPage(5, 0)).toBe(1);
    expect(clampPage(1, 0)).toBe(1);
  });
});

describe('loadRecallClientView — pagination', () => {
  beforeEach(() => {
    state.subFindFirst.mockResolvedValue(subscription());
  });

  it('reports the whole month even though it only fetched a page', async () => {
    state.callCount.mockResolvedValue(47);
    const view = await load();
    // The reader needs "1-20 de 47", not a list that stops with no
    // explanation.
    expect(view).toMatchObject({ page: 1, pageCount: 3, totalCalls: 47, pageSize: CALLS_PER_PAGE });
  });

  it('counts over the SAME window it lists', async () => {
    await load();
    // A total taken from a different filter than the list is how a pager
    // ends up promising a page that renders empty.
    expect(state.callCount.mock.calls[0][0].where).toEqual(state.callFindMany.mock.calls[0][0].where);
  });

  it('skips by whole pages', async () => {
    state.callCount.mockResolvedValue(47);
    await loadRecallClientView(prisma, 'client_1', { now: NOW, page: 3 });
    expect(state.callFindMany.mock.calls[0][0].skip).toBe(2 * CALLS_PER_PAGE);
  });

  it('clamps a page past the end once it knows the total', async () => {
    state.callCount.mockResolvedValue(21);
    const view = await loadRecallClientView(prisma, 'client_1', { now: NOW, page: 99 });
    expect(view).toMatchObject({ page: 2, pageCount: 2 });
    expect(state.callFindMany.mock.calls[0][0].skip).toBe(CALLS_PER_PAGE);
  });

  it('reports a single page for an empty month rather than zero', async () => {
    state.callCount.mockResolvedValue(0);
    const view = await load();
    expect(view).toMatchObject({ page: 1, pageCount: 1, totalCalls: 0 });
  });

  it('needs no pager when the month fits on one page', async () => {
    state.callCount.mockResolvedValue(CALLS_PER_PAGE);
    const view = await load();
    expect(view).toMatchObject({ pageCount: 1 });
  });
});
