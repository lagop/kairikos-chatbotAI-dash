// =============================================================================
// WP-XX (Fase 9) — unit tests for the blocklist.
//
// Most of the weight is on normaliseE164, because that is where this
// feature fails silently: a list that stores what the operator typed
// looks perfect in the panel and matches nothing Twilio ever sends. A
// blocklist that never blocks is worse than none, since everyone believes
// the robot has been silenced.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { normaliseE164, blockNumber, unblockNumber, isNumberBlocked } from '@/lib/recall-blocklist';

const state = {
  blockedFindUnique: vi.fn(),
  blockedUpsert: vi.fn(),
  blockedDeleteMany: vi.fn(),
  subscriptionFindUnique: vi.fn(),
};

const prisma = {
  recallBlockedNumber: {
    findUnique: (...a: unknown[]) => state.blockedFindUnique(...a),
    upsert: (...a: unknown[]) => state.blockedUpsert(...a),
    deleteMany: (...a: unknown[]) => state.blockedDeleteMany(...a),
  },
  recallSubscription: {
    findUnique: (...a: unknown[]) => state.subscriptionFindUnique(...a),
  },
} as unknown as PrismaClient;

beforeEach(() => {
  for (const fn of Object.values(state)) fn.mockReset();
  state.subscriptionFindUnique.mockResolvedValue({ clientId: 'client_1' });
  state.blockedUpsert.mockResolvedValue({ id: 'blk_1' });
  state.blockedDeleteMany.mockResolvedValue({ count: 1 });
  state.blockedFindUnique.mockResolvedValue(null);
});

describe('normaliseE164', () => {
  it('turns what an operator types into what Twilio sends', () => {
    // Every one of these is the SAME number. If any of them stored
    // differently, that block would never fire.
    for (const typed of ['651234567', '651 23 45 67', '+34 651 23 45 67', '0034651234567', '+34-651-234-567']) {
      expect(normaliseE164(typed)).toBe('+34651234567');
    }
  });

  it('keeps a foreign number on its own prefix', () => {
    expect(normaliseE164('+351 912 345 678')).toBe('+351912345678');
    expect(normaliseE164('00351912345678')).toBe('+351912345678');
  });

  it('refuses what it cannot resolve rather than guessing a country', () => {
    // Eight digits with no prefix is not a Spanish national number, and
    // inventing +34 for it would create a row that blocks the wrong
    // person or nobody at all.
    expect(normaliseE164('12345678')).toBeNull();
    expect(normaliseE164('')).toBeNull();
    expect(normaliseE164('   ')).toBeNull();
    expect(normaliseE164('anonymous')).toBeNull();
    expect(normaliseE164('123')).toBeNull();
  });
});

describe('blockNumber', () => {
  it('stores the normalised form, not the typed one', async () => {
    const result = await blockNumber(prisma, 'sub_1', '651 23 45 67', { reason: 'comercial' });
    expect(result).toEqual({ ok: true, id: 'blk_1', e164: '+34651234567' });
    const call = state.blockedUpsert.mock.calls[0][0];
    expect(call.where).toEqual({ subscriptionId_e164: { subscriptionId: 'sub_1', e164: '+34651234567' } });
    expect(call.create.e164).toBe('+34651234567');
  });

  it('upserts, so an operator clicking twice is not an error', async () => {
    await blockNumber(prisma, 'sub_1', '+34651234567', { reason: 'spam' });
    // The second attempt is usually the one where the reason got written.
    expect(state.blockedUpsert.mock.calls[0][0].update).toEqual({ reason: 'spam' });
  });

  it('denormalises the clientId from the subscription rather than trusting a caller', async () => {
    await blockNumber(prisma, 'sub_1', '+34651234567');
    expect(state.blockedUpsert.mock.calls[0][0].create.clientId).toBe('client_1');
  });

  it('rejects an unparseable number before touching the database', async () => {
    await expect(blockNumber(prisma, 'sub_1', 'no soy un número')).resolves.toEqual({
      ok: false,
      error: 'invalid_number',
    });
    expect(state.subscriptionFindUnique).not.toHaveBeenCalled();
    expect(state.blockedUpsert).not.toHaveBeenCalled();
  });

  it('reports an unknown subscription instead of orphaning a row', async () => {
    state.subscriptionFindUnique.mockResolvedValue(null);
    await expect(blockNumber(prisma, 'sub_missing', '+34651234567')).resolves.toEqual({
      ok: false,
      error: 'subscription_not_found',
    });
    expect(state.blockedUpsert).not.toHaveBeenCalled();
  });
});

describe('unblockNumber', () => {
  it('normalises before deleting, so the same string that blocked also unblocks', async () => {
    await expect(unblockNumber(prisma, 'sub_1', '651 23 45 67')).resolves.toBe(true);
    expect(state.blockedDeleteMany.mock.calls[0][0].where).toEqual({
      subscriptionId: 'sub_1',
      e164: '+34651234567',
    });
  });

  it('reports false when there was nothing to remove', async () => {
    state.blockedDeleteMany.mockResolvedValue({ count: 0 });
    await expect(unblockNumber(prisma, 'sub_1', '+34651234567')).resolves.toBe(false);
  });

  it('reports false for an unparseable number without a delete', async () => {
    await expect(unblockNumber(prisma, 'sub_1', 'xxx')).resolves.toBe(false);
    expect(state.blockedDeleteMany).not.toHaveBeenCalled();
  });
});

describe('isNumberBlocked', () => {
  it('is scoped to the subscription, not the number alone', async () => {
    await isNumberBlocked(prisma, 'sub_1', '+34651234567');
    expect(state.blockedFindUnique.mock.calls[0][0].where).toEqual({
      subscriptionId_e164: { subscriptionId: 'sub_1', e164: '+34651234567' },
    });
  });

  it('answers true only when a row exists', async () => {
    await expect(isNumberBlocked(prisma, 'sub_1', '+34651234567')).resolves.toBe(false);
    state.blockedFindUnique.mockResolvedValue({ id: 'blk_1' });
    await expect(isNumberBlocked(prisma, 'sub_1', '+34651234567')).resolves.toBe(true);
  });
});
