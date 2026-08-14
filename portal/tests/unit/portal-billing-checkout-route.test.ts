// =============================================================================
// WP-30 — unit tests for POST /api/portal/billing/checkout, the client-
// facing self-serve checkout route. Distinct from
// tests/unit/billing-checkout-route.test.ts (the WP-19 operator route,
// which bills an EXISTING ClientProduct): this route creates the
// ClientProduct itself, in 'pending_payment' state, before the first real
// `stripe.checkout.sessions.create()` call in the codebase.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  resolveClientFromSession: vi.fn(),
  isProductContracted: vi.fn(),
  findUniqueProduct: vi.fn(),
  findUniqueClient: vi.fn(),
  findUniqueClientProduct: vi.fn(),
  clientProductUpsert: vi.fn(),
  clientProductUpdate: vi.fn(),
  clientProductAuditCreate: vi.fn(),
  ensureCustomerForTenant: vi.fn(),
  isStripeConfigured: vi.fn(),
  checkoutSessionsCreate: vi.fn(),
}));

const mockTx = {
  clientProduct: {
    upsert: (...args: unknown[]) => mockState.clientProductUpsert(...args),
    update: (...args: unknown[]) => mockState.clientProductUpdate(...args),
  },
  clientProductAudit: {
    create: (...args: unknown[]) => mockState.clientProductAuditCreate(...args),
  },
};

vi.mock('@/lib/portal-session', () => ({
  resolveClientFromSession: (...args: unknown[]) => mockState.resolveClientFromSession(...args),
}));

vi.mock('@/lib/client-product-access', () => ({
  isProductContracted: (...args: unknown[]) => mockState.isProductContracted(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
    product: { findUnique: (...args: unknown[]) => mockState.findUniqueProduct(...args) },
    chatbotClient: { findUnique: (...args: unknown[]) => mockState.findUniqueClient(...args) },
    clientProduct: { findUnique: (...args: unknown[]) => mockState.findUniqueClientProduct(...args) },
  },
  isDatabaseConfigured: true,
}));

vi.mock('@/lib/stripe-billing', () => ({
  ensureCustomerForTenant: (...args: unknown[]) => mockState.ensureCustomerForTenant(...args),
}));

vi.mock('@/lib/stripe', () => ({
  isStripeConfigured: () => mockState.isStripeConfigured(),
  getStripe: () => ({
    checkout: { sessions: { create: (...args: unknown[]) => mockState.checkoutSessionsCreate(...args) } },
  }),
}));

function makeRequest(body: unknown) {
  return {
    json: async () => body,
    nextUrl: { origin: 'https://portal.kairikos.test' },
  } as unknown as Parameters<typeof import('@/app/api/portal/billing/checkout/route').POST>[0];
}

const RESOLVED = { clientId: 'client_1', email: 'a@b.com', source: 'database' as const };
const RECURRING_PRODUCT = {
  id: '11111111-1111-1111-1111-111111111111',
  code: 'leads',
  tier: 'standard',
  isActive: true,
  stripeRecurringPriceId: 'price_recurring_1',
  stripeSetupPriceId: null,
  setupFeeCents: 0,
  priceCents: 19900,
  currency: 'EUR',
};
const ONE_TIME_PRODUCT = {
  id: '22222222-2222-2222-2222-222222222222',
  code: 'web',
  tier: 'standard',
  isActive: true,
  stripeRecurringPriceId: null,
  stripeSetupPriceId: 'price_setup_web_1',
  setupFeeCents: 79900,
  priceCents: 0,
  currency: 'EUR',
};

beforeEach(() => {
  mockState.resolveClientFromSession.mockReset().mockResolvedValue(RESOLVED);
  mockState.isProductContracted.mockReset().mockResolvedValue(false);
  mockState.findUniqueProduct.mockReset().mockResolvedValue(RECURRING_PRODUCT);
  mockState.findUniqueClient.mockReset().mockResolvedValue({ id: 'client_1', tenantId: 'tenant_1' });
  mockState.findUniqueClientProduct.mockReset().mockResolvedValue(null);
  mockState.clientProductUpsert.mockReset().mockResolvedValue({ id: 'cp_1' });
  mockState.clientProductUpdate.mockReset().mockResolvedValue({ id: 'cp_1', status: 'cancelled' });
  mockState.clientProductAuditCreate.mockReset();
  mockState.ensureCustomerForTenant.mockReset().mockResolvedValue('cus_123');
  mockState.isStripeConfigured.mockReset().mockReturnValue(true);
  mockState.checkoutSessionsCreate.mockReset().mockResolvedValue({ url: 'https://checkout.stripe.com/pay/cs_test_1' });
});

describe('POST /api/portal/billing/checkout — auth and guards', () => {
  it('401s when there is no resolved client session', async () => {
    mockState.resolveClientFromSession.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/portal/billing/checkout/route');
    const res = await POST(makeRequest({ productId: RECURRING_PRODUCT.id }));
    expect(res.status).toBe(401);
    expect(mockState.checkoutSessionsCreate).not.toHaveBeenCalled();
  });

  it('503s for a dev-mock session — no real payment can be collected', async () => {
    mockState.resolveClientFromSession.mockResolvedValueOnce({ ...RESOLVED, source: 'mock_dev' });
    const { POST } = await import('@/app/api/portal/billing/checkout/route');
    const res = await POST(makeRequest({ productId: RECURRING_PRODUCT.id }));
    expect(res.status).toBe(503);
    expect(mockState.checkoutSessionsCreate).not.toHaveBeenCalled();
  });

  it('409s when the client already has the product active (AC)', async () => {
    mockState.isProductContracted.mockResolvedValueOnce(true);
    const { POST } = await import('@/app/api/portal/billing/checkout/route');
    const res = await POST(makeRequest({ productId: RECURRING_PRODUCT.id }));
    const body = await res.clone().json();
    expect(res.status).toBe(409);
    expect(body.error).toBe('already_contracted');
    expect(mockState.clientProductUpsert).not.toHaveBeenCalled();
    expect(mockState.checkoutSessionsCreate).not.toHaveBeenCalled();
  });

  it('404s for an inactive or missing product', async () => {
    mockState.findUniqueProduct.mockResolvedValueOnce({ ...RECURRING_PRODUCT, isActive: false });
    const { POST } = await import('@/app/api/portal/billing/checkout/route');
    const res = await POST(makeRequest({ productId: RECURRING_PRODUCT.id }));
    expect(res.status).toBe(404);
  });

  it('404s when a one-time-only product has neither recurring price nor setup fee provisioned', async () => {
    mockState.findUniqueProduct.mockResolvedValueOnce({
      ...ONE_TIME_PRODUCT,
      stripeSetupPriceId: null,
      setupFeeCents: 0,
    });
    const { POST } = await import('@/app/api/portal/billing/checkout/route');
    const res = await POST(makeRequest({ productId: ONE_TIME_PRODUCT.id }));
    const body = await res.clone().json();
    expect(res.status).toBe(404);
    expect(body.error).toBe('product_price_id_missing');
  });
});

describe('POST /api/portal/billing/checkout — ClientProduct pre-creation', () => {
  it('upserts a pending_payment ClientProduct and writes a checkout_started audit row before calling Stripe', async () => {
    const { POST } = await import('@/app/api/portal/billing/checkout/route');
    const res = await POST(makeRequest({ productId: RECURRING_PRODUCT.id }));

    expect(res.status).toBe(200);
    expect(mockState.clientProductUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clientId_productId: { clientId: 'client_1', productId: RECURRING_PRODUCT.id } },
        create: expect.objectContaining({ status: 'pending_payment' }),
        update: expect.objectContaining({ status: 'pending_payment', cancelledAt: null }),
      }),
    );
    expect(mockState.clientProductAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        clientProductId: 'cp_1',
        action: 'checkout_started',
        statusAfter: 'pending_payment',
        actorId: 'client:client_1',
      }),
    });
  });

  it('embeds kairikos_client_product_id in the Checkout Session metadata from creation, before Stripe is ever called', async () => {
    const { POST } = await import('@/app/api/portal/billing/checkout/route');
    await POST(makeRequest({ productId: RECURRING_PRODUCT.id }));

    const upsertCallIndex = mockState.clientProductUpsert.mock.invocationCallOrder[0];
    const stripeCallIndex = mockState.checkoutSessionsCreate.mock.invocationCallOrder[0];
    expect(upsertCallIndex).toBeLessThan(stripeCallIndex);

    expect(mockState.checkoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ kairikos_client_product_id: 'cp_1' }),
        subscription_data: expect.objectContaining({
          metadata: expect.objectContaining({ kairikos_client_product_id: 'cp_1' }),
        }),
      }),
    );
  });
});

describe('POST /api/portal/billing/checkout — session mode branching', () => {
  it('creates a subscription-mode session with just the recurring line item when there is no setup fee', async () => {
    const { POST } = await import('@/app/api/portal/billing/checkout/route');
    await POST(makeRequest({ productId: RECURRING_PRODUCT.id }));

    expect(mockState.checkoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'subscription',
        line_items: [{ price: 'price_recurring_1', quantity: 1 }],
      }),
    );
  });

  it('adds the one-time setup price as a second line item in subscription mode when present', async () => {
    mockState.findUniqueProduct.mockResolvedValueOnce({
      ...RECURRING_PRODUCT,
      stripeSetupPriceId: 'price_setup_1',
      setupFeeCents: 9900,
    });
    const { POST } = await import('@/app/api/portal/billing/checkout/route');
    await POST(makeRequest({ productId: RECURRING_PRODUCT.id }));

    expect(mockState.checkoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'subscription',
        line_items: [
          { price: 'price_recurring_1', quantity: 1 },
          { price: 'price_setup_1', quantity: 1 },
        ],
      }),
    );
  });

  it('creates a payment-mode session with invoice_creation enabled for a one-time-only product', async () => {
    mockState.findUniqueProduct.mockResolvedValueOnce(ONE_TIME_PRODUCT);
    const { POST } = await import('@/app/api/portal/billing/checkout/route');
    const res = await POST(makeRequest({ productId: ONE_TIME_PRODUCT.id }));

    expect(res.status).toBe(200);
    expect(mockState.checkoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'payment',
        line_items: [{ price: 'price_setup_web_1', quantity: 1 }],
        invoice_creation: expect.objectContaining({
          enabled: true,
          invoice_data: expect.objectContaining({
            metadata: expect.objectContaining({ kairikos_client_product_id: 'cp_1' }),
          }),
        }),
      }),
    );
  });
});

describe('POST /api/portal/billing/checkout — Stripe failure rollback', () => {
  it('reverts the ClientProduct and writes a checkout_failed audit row when session creation throws', async () => {
    mockState.checkoutSessionsCreate.mockRejectedValueOnce(new Error('stripe_down'));
    const { POST } = await import('@/app/api/portal/billing/checkout/route');
    const res = await POST(makeRequest({ productId: RECURRING_PRODUCT.id }));
    const body = await res.clone().json();

    expect(res.status).toBe(502);
    expect(body.error).toBe('stripe_error');
    expect(mockState.clientProductUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cp_1' }, data: expect.objectContaining({ status: 'cancelled' }) }),
    );
    expect(mockState.clientProductAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'checkout_failed', statusBefore: 'pending_payment' }),
    });
  });

  it('reverts to the prior status (not cancelled) when the ClientProduct already existed before this attempt', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce({ status: 'paused' });
    mockState.checkoutSessionsCreate.mockRejectedValueOnce(new Error('stripe_down'));
    mockState.clientProductUpdate.mockResolvedValueOnce({ id: 'cp_1', status: 'paused' });
    const { POST } = await import('@/app/api/portal/billing/checkout/route');
    await POST(makeRequest({ productId: RECURRING_PRODUCT.id }));

    expect(mockState.clientProductUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'paused', cancelledAt: null }) }),
    );
  });
});
