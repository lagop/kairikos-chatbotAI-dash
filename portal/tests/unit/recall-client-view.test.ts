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

import { loadRecallClientView, HISTORY_MONTHS, RECENT_CALLS } from '@/lib/recall-client-view';
import { RECORDING_RETENTION_DAYS } from '@/lib/recall-retention';

const state = {
  subFindFirst: vi.fn(),
  usageFindMany: vi.fn(),
  callFindMany: vi.fn(),
};

const prisma = {
  recallSubscription: { findFirst: (...a: unknown[]) => state.subFindFirst(...a) },
  recallUsageMonth: { findMany: (...a: unknown[]) => state.usageFindMany(...a) },
  callEvent: { findMany: (...a: unknown[]) => state.callFindMany(...a) },
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
  state.callFindMany.mockResolvedValue([]);
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
  });

  it('explains itself rather than showing an empty dashboard while onboarding', async () => {
    state.subFindFirst.mockResolvedValue(subscription({ status: 'forwarding_pending', activatedAt: null }));

    await expect(load()).resolves.toEqual({
      state: 'onboarding',
      status: 'forwarding_pending',
      since: new Date('2026-06-01T09:00:00.000Z'),
      virtualNumber: '+34910555123',
    });
    // An empty dashboard here would read as "we sold you nothing".
    expect(mockState.computeMonthlyMetrics).not.toHaveBeenCalled();
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

  it('turns stored seconds into minutes for the history table', async () => {
    state.usageFindMany.mockResolvedValue([
      { localMonth: '2026-07', calls: 7, recordedCalls: 5, callSeconds: 305, reviewRequests: 3 },
      { localMonth: '2026-06', calls: 4, recordedCalls: 2, callSeconds: 60, reviewRequests: 1 },
    ]);

    const view = await load();
    expect(view).toMatchObject({
      history: [
        { localMonth: '2026-07', calls: 7, recordedCalls: 5, minutes: 5, reviewRequests: 3 },
        { localMonth: '2026-06', calls: 4, recordedCalls: 2, minutes: 1, reviewRequests: 1 },
      ],
    });
  });

  it('shows the newest months first, bounded to a year', async () => {
    await load();
    const query = state.usageFindMany.mock.calls[0][0];
    expect(query.orderBy).toEqual({ localMonth: 'desc' });
    expect(query.take).toBe(HISTORY_MONTHS);
  });

  it('leaves the current month out of the history table', async () => {
    await load();
    // It is already shown, live, in the summary above the table.
    // Listing it twice would also let the two disagree: the summary is
    // computed now, the row was written by the last roll-up.
    expect(state.usageFindMany.mock.calls[0][0].where.localMonth).toEqual({ lt: '2026-07' });
  });

  it('hides calls the client asked us to block', async () => {
    await load();
    // Listing them back is noise about a decision he already made.
    expect(state.callFindMany.mock.calls[0][0].where.outcome).toEqual({ not: 'blocked' });
  });

  it('lists recent calls newest first, bounded', async () => {
    await load();
    const query = state.callFindMany.mock.calls[0][0];
    expect(query.orderBy).toEqual({ startedAt: 'desc' });
    expect(query.take).toBe(RECENT_CALLS);
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
