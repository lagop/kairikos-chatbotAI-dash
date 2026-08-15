// =============================================================================
// Unit tests for src/lib/stripe-catalog.ts — bootstrap/reprice of a
// product tier's Stripe Product/Price objects.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  findUniqueOrThrow: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  auditCreate: vi.fn(),
  subscriptionCount: vi.fn(),
  productsCreate: vi.fn(),
  pricesCreate: vi.fn(),
  pricesUpdate: vi.fn(),
  resolveActiveStripeSecret: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    product: {
      findUniqueOrThrow: (...args: unknown[]) => mockState.findUniqueOrThrow(...args),
      update: (...args: unknown[]) => mockState.update(...args),
      updateMany: (...args: unknown[]) => mockState.updateMany(...args),
    },
    stripeCatalogAudit: {
      create: (...args: unknown[]) => mockState.auditCreate(...args),
    },
    subscription: {
      count: (...args: unknown[]) => mockState.subscriptionCount(...args),
    },
    $transaction: (ops: unknown[]) => Promise.all(ops),
  },
}));

vi.mock('@/lib/stripe', () => ({
  getStripe: async () => ({
    products: { create: (...args: unknown[]) => mockState.productsCreate(...args) },
    prices: {
      create: (...args: unknown[]) => mockState.pricesCreate(...args),
      update: (...args: unknown[]) => mockState.pricesUpdate(...args),
    },
  }),
}));

vi.mock('@/lib/stripe-credentials', () => ({
  resolveActiveStripeSecret: (...args: unknown[]) => mockState.resolveActiveStripeSecret(...args),
}));

vi.mock('@/lib/observability', () => ({
  logError: vi.fn(),
}));

import {
  bootstrapStripeProductForTier,
  repriceStripeTier,
  reconcileStripeProductForTier,
  countActiveSubscriptionsForProduct,
} from '@/lib/stripe-catalog';

const ACTOR = { operatorId: 'op_1', operatorEmail: 'lucia@kairikos.com' };

const UNBOOTSTRAPPED_PRODUCT = {
  id: 'prod_reviews_basic',
  code: 'reviews',
  tier: 'basic',
  name: 'Reseñas en Google — Basic',
  priceCents: 9900,
  setupFeeCents: 9900,
  currency: 'EUR',
  stripeProductId: null,
  stripeRecurringPriceId: null,
  stripeSetupPriceId: null,
  stripePriceMode: null,
};

const BOOTSTRAPPED_PRODUCT = {
  ...UNBOOTSTRAPPED_PRODUCT,
  stripeProductId: 'prod_stripe_1',
  stripeRecurringPriceId: 'price_old_recurring',
  stripeSetupPriceId: 'price_old_setup',
  stripePriceMode: 'test',
};

beforeEach(() => {
  Object.values(mockState).forEach((fn) => fn.mockReset && fn.mockReset());
  mockState.resolveActiveStripeSecret.mockResolvedValue({ mode: 'test', key: 'sk_test_x' });
  mockState.auditCreate.mockResolvedValue({});
});

describe('bootstrapStripeProductForTier', () => {
  it('creates a Stripe Product + recurring + setup Price, persists, and audits price_bootstrap_created', async () => {
    mockState.findUniqueOrThrow.mockResolvedValueOnce(UNBOOTSTRAPPED_PRODUCT);
    mockState.productsCreate.mockResolvedValueOnce({ id: 'prod_stripe_new' });
    mockState.pricesCreate
      .mockResolvedValueOnce({ id: 'price_recurring_new' })
      .mockResolvedValueOnce({ id: 'price_setup_new' });
    mockState.update.mockResolvedValueOnce({
      ...UNBOOTSTRAPPED_PRODUCT,
      stripeProductId: 'prod_stripe_new',
      stripeRecurringPriceId: 'price_recurring_new',
      stripeSetupPriceId: 'price_setup_new',
      stripePriceMode: 'test',
    });

    const result = await bootstrapStripeProductForTier('prod_reviews_basic', ACTOR);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.product.stripeProductId).toBe('prod_stripe_new');
    }
    expect(mockState.productsCreate).toHaveBeenCalledTimes(1);
    expect(mockState.pricesCreate).toHaveBeenCalledTimes(2);
    expect(mockState.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'price_bootstrap_created', actorOperatorId: 'op_1' }),
      }),
    );
  });

  it('does not create a recurring Price when priceCents is 0 (one-time-only product)', async () => {
    mockState.findUniqueOrThrow.mockResolvedValueOnce({ ...UNBOOTSTRAPPED_PRODUCT, priceCents: 0, setupFeeCents: 79900 });
    mockState.productsCreate.mockResolvedValueOnce({ id: 'prod_stripe_new' });
    mockState.pricesCreate.mockResolvedValueOnce({ id: 'price_setup_new' });
    mockState.update.mockResolvedValueOnce({});

    await bootstrapStripeProductForTier('prod_web', ACTOR);

    expect(mockState.pricesCreate).toHaveBeenCalledTimes(1);
    expect(mockState.pricesCreate).toHaveBeenCalledWith(
      expect.not.objectContaining({ recurring: expect.anything() }),
    );
  });

  it('returns already_bootstrapped without calling Stripe when stripeProductId is already set', async () => {
    mockState.findUniqueOrThrow.mockResolvedValueOnce(BOOTSTRAPPED_PRODUCT);

    const result = await bootstrapStripeProductForTier('prod_reviews_basic', ACTOR);

    expect(result).toEqual({ ok: false, error: { kind: 'already_bootstrapped' } });
    expect(mockState.productsCreate).not.toHaveBeenCalled();
  });

  it('returns partial_failure with the created Stripe ids when the local write fails, and does not retry Stripe', async () => {
    mockState.findUniqueOrThrow.mockResolvedValueOnce(UNBOOTSTRAPPED_PRODUCT);
    mockState.productsCreate.mockResolvedValueOnce({ id: 'prod_stripe_orphan' });
    mockState.pricesCreate
      .mockResolvedValueOnce({ id: 'price_recurring_orphan' })
      .mockResolvedValueOnce({ id: 'price_setup_orphan' });
    mockState.update.mockRejectedValueOnce(new Error('db_write_failed'));

    const result = await bootstrapStripeProductForTier('prod_reviews_basic', ACTOR);

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'partial_failure',
        stripeProductId: 'prod_stripe_orphan',
        stripeRecurringPriceId: 'price_recurring_orphan',
        stripeSetupPriceId: 'price_setup_orphan',
      },
    });
    expect(mockState.productsCreate).toHaveBeenCalledTimes(1);
  });
});

describe('repriceStripeTier', () => {
  const REPRICE_INPUT = {
    productId: 'prod_reviews_basic',
    newPriceCents: 12900,
    newSetupFeeCents: null,
    expectedPriceCents: 9900,
    expectedSetupFeeCents: 9900,
  };

  it('creates a new recurring Price, archives the old one, and updates the row', async () => {
    mockState.findUniqueOrThrow
      .mockResolvedValueOnce(BOOTSTRAPPED_PRODUCT) // initial read
      .mockResolvedValueOnce({ ...BOOTSTRAPPED_PRODUCT, priceCents: 12900, stripeRecurringPriceId: 'price_new' }); // post-update read
    mockState.pricesCreate.mockResolvedValueOnce({ id: 'price_new' });
    mockState.pricesUpdate.mockResolvedValueOnce({});
    mockState.updateMany.mockResolvedValueOnce({ count: 1 });

    const result = await repriceStripeTier(REPRICE_INPUT, ACTOR);

    expect(result.ok).toBe(true);
    expect(mockState.pricesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ product: 'prod_stripe_1', unit_amount: 12900, recurring: { interval: 'month' } }),
    );
    expect(mockState.pricesUpdate).toHaveBeenCalledWith('price_old_recurring', { active: false });
    expect(mockState.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'price_repriced' }) }),
    );
  });

  it('never calls stripe.subscriptions.update — existing subscribers keep their old price', async () => {
    // The mocked Stripe client has no `subscriptions` namespace at all;
    // if repriceStripeTier ever called it, this test would throw
    // "stripe.subscriptions is undefined" rather than silently passing.
    mockState.findUniqueOrThrow
      .mockResolvedValueOnce(BOOTSTRAPPED_PRODUCT)
      .mockResolvedValueOnce(BOOTSTRAPPED_PRODUCT);
    mockState.pricesCreate.mockResolvedValueOnce({ id: 'price_new' });
    mockState.pricesUpdate.mockResolvedValueOnce({});
    mockState.updateMany.mockResolvedValueOnce({ count: 1 });

    const result = await repriceStripeTier(REPRICE_INPUT, ACTOR);
    expect(result.ok).toBe(true);
  });

  it('completes successfully even when archiving the old price fails (best-effort)', async () => {
    mockState.findUniqueOrThrow
      .mockResolvedValueOnce(BOOTSTRAPPED_PRODUCT)
      .mockResolvedValueOnce(BOOTSTRAPPED_PRODUCT);
    mockState.pricesCreate.mockResolvedValueOnce({ id: 'price_new' });
    mockState.pricesUpdate.mockRejectedValueOnce(new Error('stripe_archive_failed'));
    mockState.updateMany.mockResolvedValueOnce({ count: 1 });

    const result = await repriceStripeTier(REPRICE_INPUT, ACTOR);

    expect(result.ok).toBe(true);
    expect(mockState.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'price_archive_failed' }) }),
    );
  });

  it('returns not_bootstrapped_yet without touching Stripe when stripeProductId is NULL', async () => {
    mockState.findUniqueOrThrow.mockResolvedValueOnce(UNBOOTSTRAPPED_PRODUCT);

    const result = await repriceStripeTier(REPRICE_INPUT, ACTOR);

    expect(result).toEqual({ ok: false, error: { kind: 'not_bootstrapped_yet' } });
    expect(mockState.pricesCreate).not.toHaveBeenCalled();
  });

  it('returns concurrent_modification without touching Stripe when expected values are stale', async () => {
    mockState.findUniqueOrThrow.mockResolvedValueOnce({ ...BOOTSTRAPPED_PRODUCT, priceCents: 14900 });

    const result = await repriceStripeTier(REPRICE_INPUT, ACTOR);

    expect(result).toEqual({ ok: false, error: { kind: 'concurrent_modification' } });
    expect(mockState.pricesCreate).not.toHaveBeenCalled();
  });

  it('clears stripeSetupPriceId and archives the old setup price when newSetupFeeCents is 0', async () => {
    mockState.findUniqueOrThrow
      .mockResolvedValueOnce(BOOTSTRAPPED_PRODUCT)
      .mockResolvedValueOnce({ ...BOOTSTRAPPED_PRODUCT, setupFeeCents: 0, stripeSetupPriceId: null });
    mockState.pricesCreate.mockResolvedValueOnce({ id: 'price_new_recurring' });
    mockState.pricesUpdate.mockResolvedValue({});
    mockState.updateMany.mockResolvedValueOnce({ count: 1 });

    await repriceStripeTier({ ...REPRICE_INPUT, newSetupFeeCents: 0 }, ACTOR);

    expect(mockState.update).not.toHaveBeenCalled(); // uses updateMany, not update
    const dataArg = mockState.updateMany.mock.calls[0][0].data;
    expect(dataArg.stripeSetupPriceId).toBeNull();
    expect(dataArg.setupFeeCents).toBe(0);
    expect(mockState.pricesUpdate).toHaveBeenCalledWith('price_old_setup', { active: false });
  });

  it('returns partial_failure when the update matches 0 rows (a concurrent write raced past the initial check)', async () => {
    mockState.findUniqueOrThrow.mockResolvedValueOnce(BOOTSTRAPPED_PRODUCT);
    mockState.pricesCreate.mockResolvedValueOnce({ id: 'price_new' });
    mockState.pricesUpdate.mockResolvedValueOnce({});
    mockState.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await repriceStripeTier(REPRICE_INPUT, ACTOR);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('partial_failure');
    }
  });
});

describe('reconcileStripeProductForTier', () => {
  it('persists the given Stripe ids without calling Stripe again', async () => {
    mockState.findUniqueOrThrow.mockResolvedValueOnce(UNBOOTSTRAPPED_PRODUCT);
    mockState.update.mockResolvedValueOnce({
      ...UNBOOTSTRAPPED_PRODUCT,
      stripeProductId: 'prod_orphan',
      stripeRecurringPriceId: 'price_orphan',
    });

    const result = await reconcileStripeProductForTier(
      'prod_reviews_basic',
      { stripeProductId: 'prod_orphan', stripeRecurringPriceId: 'price_orphan', stripeSetupPriceId: null },
      ACTOR,
    );

    expect(result.ok).toBe(true);
    expect(mockState.productsCreate).not.toHaveBeenCalled();
    expect(mockState.pricesCreate).not.toHaveBeenCalled();
    expect(mockState.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'reconciled_after_partial_failure' }) }),
    );
  });
});

describe('countActiveSubscriptionsForProduct', () => {
  it('counts only active/trialing subscriptions for the given product', async () => {
    mockState.subscriptionCount.mockResolvedValueOnce(3);

    const count = await countActiveSubscriptionsForProduct('prod_reviews_basic');

    expect(count).toBe(3);
    expect(mockState.subscriptionCount).toHaveBeenCalledWith({
      where: { status: { in: ['active', 'trialing'] }, clientProduct: { productId: 'prod_reviews_basic' } },
    });
  });
});
