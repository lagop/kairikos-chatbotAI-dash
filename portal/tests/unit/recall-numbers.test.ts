// =============================================================================
// WP-XX — unit tests for the virtual-number pool (src/lib/recall-numbers.ts).
//
// The telephony provider is the in-memory fake (src/lib/telephony/fake.ts),
// which is a real implementation of the contract rather than a stub — so
// these exercise the actual provisioning/release logic, including the
// idempotency promise, without touching Twilio.
//
// Prisma is mocked at the call level (not a real DB) in the style of the
// other route/lib tests in this suite.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createFakeTelephonyProvider } from '@/lib/telephony/fake';
import {
  provisionIntoPool,
  assignNumberToSubscription,
  releaseNumber,
  getPoolSummary,
} from '@/lib/recall-numbers';

const state = {
  virtualNumberCreate: vi.fn(),
  virtualNumberFindFirst: vi.fn(),
  virtualNumberFindUnique: vi.fn(),
  virtualNumberUpdate: vi.fn(),
  virtualNumberUpdateMany: vi.fn(),
  virtualNumberGroupBy: vi.fn(),
  recallSubscriptionFindUnique: vi.fn(),
  recallSubscriptionUpdate: vi.fn(),
};

const prisma = {
  virtualNumber: {
    create: (...a: unknown[]) => state.virtualNumberCreate(...a),
    findFirst: (...a: unknown[]) => state.virtualNumberFindFirst(...a),
    findUnique: (...a: unknown[]) => state.virtualNumberFindUnique(...a),
    update: (...a: unknown[]) => state.virtualNumberUpdate(...a),
    updateMany: (...a: unknown[]) => state.virtualNumberUpdateMany(...a),
    groupBy: (...a: unknown[]) => state.virtualNumberGroupBy(...a),
  },
  recallSubscription: {
    findUnique: (...a: unknown[]) => state.recallSubscriptionFindUnique(...a),
    update: (...a: unknown[]) => state.recallSubscriptionUpdate(...a),
  },
} as unknown as PrismaClient;

let provider = createFakeTelephonyProvider();

beforeEach(() => {
  provider = createFakeTelephonyProvider();
  for (const fn of Object.values(state)) fn.mockReset();
  let created = 0;
  state.virtualNumberCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) => {
    created += 1;
    return Promise.resolve({ id: `vn_${created}`, ...data });
  });
  state.virtualNumberUpdate.mockResolvedValue({});
  state.recallSubscriptionUpdate.mockResolvedValue({});
});

describe('provisionIntoPool', () => {
  it('buys exactly the requested count and records each one', async () => {
    const result = await provisionIntoPool(prisma, provider, { countryCode: 'ES', count: 2 });

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.provisioned).toHaveLength(2);
    expect(result.failed).toEqual([]);
    // Bought at the provider, not just recorded locally.
    expect(provider.provisioned.size).toBe(2);
    expect(state.virtualNumberCreate).toHaveBeenCalledTimes(2);
  });

  it('persists only AFTER the provider confirms — never claims a number we do not own', async () => {
    provider.failNext('provision', '21422: number is not available');
    const result = await provisionIntoPool(prisma, provider, { countryCode: 'ES', count: 1 });

    if ('error' in result) throw new Error('unexpected search failure');
    // The first candidate failed, so it moved to the next one: one bought,
    // one recorded as failed, and exactly one row written.
    expect(result.provisioned).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(state.virtualNumberCreate).toHaveBeenCalledTimes(1);
  });

  it('does not abort the batch when one candidate is taken mid-purchase', async () => {
    provider.failNext('provision', '21422: number is not available');
    const result = await provisionIntoPool(prisma, provider, { countryCode: 'ES', count: 2 });

    if ('error' in result) throw new Error('unexpected search failure');
    expect(result.provisioned).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
  });

  it('reports a search failure as an error rather than an empty batch', async () => {
    provider.failNext('search', 'twilio_unreachable');
    const result = await provisionIntoPool(prisma, provider, { countryCode: 'ES', count: 2 });

    expect(result).toEqual({ error: 'twilio_unreachable' });
    expect(state.virtualNumberCreate).not.toHaveBeenCalled();
  });

  it('flags the reconcilable direction loudly: bought at the provider but not persisted', async () => {
    state.virtualNumberCreate.mockRejectedValueOnce(new Error('unique constraint'));
    const result = await provisionIntoPool(prisma, provider, { countryCode: 'ES', count: 1 });

    if ('error' in result) throw new Error('unexpected search failure');
    expect(result.failed[0].error).toBe('provisioned_but_not_persisted');
    // The number really was bought — this is the case that shows up on the
    // provider invoice and has to be reconcilable from the logs.
    expect(provider.provisioned.size).toBeGreaterThan(0);
  });

  it('stops at `count` even when many candidates are available', async () => {
    const result = await provisionIntoPool(prisma, provider, { countryCode: 'ES', count: 1 });
    if ('error' in result) throw new Error('unexpected search failure');
    expect(result.provisioned).toHaveLength(1);
    expect(provider.provisioned.size).toBe(1);
  });
});

describe('assignNumberToSubscription', () => {
  it('404s an unknown subscription', async () => {
    state.recallSubscriptionFindUnique.mockResolvedValue(null);
    const result = await assignNumberToSubscription(prisma, '11111111-1111-1111-1111-111111111111');
    expect(result).toEqual({ ok: false, error: 'subscription_not_found' });
  });

  it('refuses a status that cannot bind a number yet — the rule lives in recall.ts', async () => {
    state.recallSubscriptionFindUnique.mockResolvedValue({
      id: 's1',
      status: 'contract_signed', // before meta_connected
      virtualNumber: null,
    });
    const result = await assignNumberToSubscription(prisma, '11111111-1111-1111-1111-111111111111');
    expect(result).toEqual({ ok: false, error: 'invalid_status' });
    expect(state.virtualNumberUpdateMany).not.toHaveBeenCalled();
  });

  it('refuses to double-assign a subscription that already has a number', async () => {
    state.recallSubscriptionFindUnique.mockResolvedValue({
      id: 's1',
      status: 'active',
      virtualNumber: { id: 'vn_existing' },
    });
    const result = await assignNumberToSubscription(prisma, '11111111-1111-1111-1111-111111111111');
    expect(result).toEqual({ ok: false, error: 'already_assigned' });
  });

  it('claims the oldest available number without calling the provider', async () => {
    state.recallSubscriptionFindUnique.mockResolvedValue({ id: 's1', status: 'meta_connected', virtualNumber: null });
    state.virtualNumberFindFirst.mockResolvedValue({ id: 'vn_1', e164: '+34910000001' });
    state.virtualNumberUpdateMany.mockResolvedValue({ count: 1 });

    const result = await assignNumberToSubscription(prisma, '11111111-1111-1111-1111-111111111111');

    expect(result).toEqual({ ok: true, numberId: 'vn_1', e164: '+34910000001', advancedTo: 'number_assigned' });
    // The pool exists so the alta never waits on Twilio.
    expect(provider.provisioned.size).toBe(0);
    // Oldest first, so the pool drains in the order it was bought.
    expect(state.virtualNumberFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { provisionedAt: 'asc' } }),
    );
  });

  it('claims with a compare-and-swap so two operators cannot get the same number', async () => {
    state.recallSubscriptionFindUnique.mockResolvedValue({ id: 's1', status: 'meta_connected', virtualNumber: null });
    state.virtualNumberFindFirst
      .mockResolvedValueOnce({ id: 'vn_1', e164: '+34910000001' })
      .mockResolvedValueOnce({ id: 'vn_2', e164: '+34910000002' });
    // First claim loses the race (someone else took vn_1), second wins.
    state.virtualNumberUpdateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

    const result = await assignNumberToSubscription(prisma, '11111111-1111-1111-1111-111111111111');

    expect(result).toEqual({ ok: true, numberId: 'vn_2', e164: '+34910000002', advancedTo: 'number_assigned' });
    // The predicates are what make it a CAS rather than a blind write.
    expect(state.virtualNumberUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'available', subscriptionId: null }),
      }),
    );
  });

  it('reports an empty pool rather than hanging or inventing a number', async () => {
    state.recallSubscriptionFindUnique.mockResolvedValue({ id: 's1', status: 'meta_connected', virtualNumber: null });
    state.virtualNumberFindFirst.mockResolvedValue(null);

    const result = await assignNumberToSubscription(prisma, '11111111-1111-1111-1111-111111111111');
    expect(result).toEqual({ ok: false, error: 'pool_empty' });
  });

  it('gives up after a bounded number of lost races instead of looping forever', async () => {
    state.recallSubscriptionFindUnique.mockResolvedValue({ id: 's1', status: 'meta_connected', virtualNumber: null });
    state.virtualNumberFindFirst.mockResolvedValue({ id: 'vn_1', e164: '+34910000001' });
    state.virtualNumberUpdateMany.mockResolvedValue({ count: 0 });

    const result = await assignNumberToSubscription(prisma, '11111111-1111-1111-1111-111111111111');
    expect(result).toEqual({ ok: false, error: 'pool_empty' });
    expect(state.virtualNumberUpdateMany.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('advances meta_connected → number_assigned and stamps numberAssignedAt', async () => {
    state.recallSubscriptionFindUnique.mockResolvedValue({ id: 's1', status: 'meta_connected', virtualNumber: null });
    state.virtualNumberFindFirst.mockResolvedValue({ id: 'vn_1', e164: '+34910000001' });
    state.virtualNumberUpdateMany.mockResolvedValue({ count: 1 });

    await assignNumberToSubscription(prisma, '11111111-1111-1111-1111-111111111111');

    expect(state.recallSubscriptionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: '11111111-1111-1111-1111-111111111111' },
        data: expect.objectContaining({ status: 'number_assigned' }),
      }),
    );
  });

  it('re-assigning a number to an already-active subscription does not move status backward', async () => {
    state.recallSubscriptionFindUnique.mockResolvedValue({ id: 's1', status: 'active', virtualNumber: null });
    state.virtualNumberFindFirst.mockResolvedValue({ id: 'vn_1', e164: '+34910000001' });
    state.virtualNumberUpdateMany.mockResolvedValue({ count: 1 });

    const result = await assignNumberToSubscription(prisma, '11111111-1111-1111-1111-111111111111');

    expect(result).toEqual({ ok: true, numberId: 'vn_1', e164: '+34910000001', advancedTo: null });
    expect(state.recallSubscriptionUpdate).not.toHaveBeenCalled();
  });
});

describe('releaseNumber', () => {
  it('404s an unknown number', async () => {
    state.virtualNumberFindUnique.mockResolvedValue(null);
    const result = await releaseNumber(prisma, provider, 'vn_missing');
    expect(result).toEqual({ ok: false, error: 'number_not_found' });
  });

  it('refuses to release twice', async () => {
    state.virtualNumberFindUnique.mockResolvedValue({ id: 'vn_1', status: 'released', providerSid: 'PN1' });
    const result = await releaseNumber(prisma, provider, 'vn_1');
    expect(result).toEqual({ ok: false, error: 'already_released' });
  });

  it('releases at the provider first, then marks the row released and clears the binding', async () => {
    const bought = await provider.provisionNumber({ e164: '+34910000001' });
    if (!bought.ok) throw new Error('fixture failed');
    state.virtualNumberFindUnique.mockResolvedValue({
      id: 'vn_1',
      status: 'assigned',
      providerSid: bought.data.providerSid,
    });

    const result = await releaseNumber(prisma, provider, 'vn_1');

    expect(result).toEqual({ ok: true });
    expect(provider.provisioned.size).toBe(0);
    expect(state.virtualNumberUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'released', subscriptionId: null, lastError: null }),
      }),
    );
  });

  it('keeps the row as-is and records lastError when the provider rejects the release', async () => {
    state.virtualNumberFindUnique.mockResolvedValue({ id: 'vn_1', status: 'assigned', providerSid: 'PN1' });
    provider.failNext('release', 'twilio_500');

    const result = await releaseNumber(prisma, provider, 'vn_1');

    expect(result).toEqual({ ok: false, error: 'provider_failed', detail: 'twilio_500' });
    // Never marked released: a number we are still billed for must not
    // vanish from our own inventory.
    expect(state.virtualNumberUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { lastError: 'twilio_500' } }),
    );
  });

  it('treats releasing an already-gone provider number as success (idempotent by contract)', async () => {
    state.virtualNumberFindUnique.mockResolvedValue({ id: 'vn_1', status: 'assigned', providerSid: 'PN_unknown' });
    const result = await releaseNumber(prisma, provider, 'vn_1');
    expect(result).toEqual({ ok: true });
  });
});

describe('getPoolSummary', () => {
  it('counts each status, defaulting the ones with no rows to zero', async () => {
    state.virtualNumberGroupBy.mockResolvedValue([
      { status: 'available', _count: { _all: 4 } },
      { status: 'assigned', _count: { _all: 7 } },
    ]);
    await expect(getPoolSummary(prisma)).resolves.toEqual({ available: 4, assigned: 7, released: 0 });
  });
});
