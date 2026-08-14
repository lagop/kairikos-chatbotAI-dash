// =============================================================================
// WP-12 / WP-19 — unit tests for POST /api/admin/portal/billing/checkout.
//
// WP-12 covered the setup-fee handling: a Product can now carry a
// one-time setupFeeCents alongside its recurring priceCents. If there's a
// fee to charge, the route must refuse to create a subscription unless the
// fee's Stripe price is provisioned (stripeSetupPriceId) — otherwise the
// client would be silently undercharged — and when it IS provisioned, the
// fee rides along as an `add_invoice_items` entry on the same subscription
// create call.
//
// WP-19 adds:
//   * A product with NO recurring price at all (stripeRecurringPriceId
//     null — e.g. the web platform's pago único) creates a one-off
//     Invoice instead of a Subscription.
//   * The current_period_start/end null-date fix: a fresh 'incomplete'
//     subscription has neither field populated by Stripe yet; the route
//     used to write `new Date(0)` (1970-01-01) via `?? 0`, now it writes
//     `null` via toDate() (imported for real — it's a pure function, no
//     need to mock it).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  findUniqueClientProduct: vi.fn(),
  subscriptionUpsert: vi.fn(),
  ensureCustomerForTenant: vi.fn(),
  createOneTimeInvoice: vi.fn(),
  syncInvoiceFromStripe: vi.fn(),
  findUniqueOrThrowInvoice: vi.fn(),
  isStripeConfigured: vi.fn(),
  subscriptionsCreate: vi.fn(),
}));

vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...args: unknown[]) => mockState.authenticateAdminRequest(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    clientProduct: {
      findUnique: (...args: unknown[]) => mockState.findUniqueClientProduct(...args),
    },
    subscription: {
      upsert: (...args: unknown[]) => mockState.subscriptionUpsert(...args),
    },
    invoice: {
      findUniqueOrThrow: (...args: unknown[]) => mockState.findUniqueOrThrowInvoice(...args),
    },
  },
  isDatabaseConfigured: true,
}));

vi.mock('@/lib/stripe-billing', async (importOriginal) => {
  // toDate is a pure function — import it for real so the null-date
  // assertions exercise the actual fix, not a mock standing in for it.
  const actual = await importOriginal<typeof import('@/lib/stripe-billing')>();
  return {
    toDate: actual.toDate,
    ensureCustomerForTenant: (...args: unknown[]) => mockState.ensureCustomerForTenant(...args),
    createOneTimeInvoice: (...args: unknown[]) => mockState.createOneTimeInvoice(...args),
    syncInvoiceFromStripe: (...args: unknown[]) => mockState.syncInvoiceFromStripe(...args),
  };
});

vi.mock('@/lib/stripe', () => ({
  isStripeConfigured: () => mockState.isStripeConfigured(),
  getStripe: () => ({
    subscriptions: { create: (...args: unknown[]) => mockState.subscriptionsCreate(...args) },
  }),
}));

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<
    typeof import('@/app/api/admin/portal/billing/checkout/route').POST
  >[0];
}

const BASE_CLIENT_PRODUCT = {
  id: 'cp_1',
  client: { id: 'client_1', tenantId: 'tenant_1', email: 'a@b.com', name: 'Client' },
};

beforeEach(() => {
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue({ ok: true, operatorId: 'op_1' });
  mockState.findUniqueClientProduct.mockReset();
  mockState.subscriptionUpsert.mockReset().mockResolvedValue({ id: 'sub_row_1', status: 'incomplete' });
  mockState.ensureCustomerForTenant.mockReset().mockResolvedValue('cus_123');
  mockState.createOneTimeInvoice.mockReset();
  mockState.syncInvoiceFromStripe.mockReset().mockResolvedValue(undefined);
  mockState.findUniqueOrThrowInvoice.mockReset();
  mockState.isStripeConfigured.mockReset().mockReturnValue(true);
  mockState.subscriptionsCreate.mockReset().mockResolvedValue({
    id: 'sub_stripe_1',
    status: 'incomplete',
    cancel_at_period_end: false,
    metadata: {},
    // WP-19 — a fresh 'incomplete' subscription genuinely has neither
    // field yet; omitting them (not `= 0`) is what the old `?? 0` bug
    // masked.
  });
});

describe('POST /api/admin/portal/billing/checkout — setup fee handling (WP-12)', () => {
  it('refuses with 404 when the product has a setup fee but no Stripe setup price provisioned', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce({
      ...BASE_CLIENT_PRODUCT,
      product: {
        id: 'prod_1',
        tier: 'pro',
        stripeRecurringPriceId: 'price_recurring_1',
        stripeSetupPriceId: null,
        setupFeeCents: 39900,
        priceCents: 24900,
        currency: 'EUR',
      },
    });

    const { POST } = await import('@/app/api/admin/portal/billing/checkout/route');
    const res = await POST(makeRequest({ clientProductId: '11111111-1111-1111-1111-111111111111' }));
    const body = await res.clone().json();

    expect(res.status).toBe(404);
    expect(body.error).toBe('product_setup_price_id_missing');
    expect(mockState.subscriptionsCreate).not.toHaveBeenCalled();
  });

  it('includes add_invoice_items for the setup fee when its Stripe price IS provisioned', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce({
      ...BASE_CLIENT_PRODUCT,
      product: {
        id: 'prod_1',
        code: 'chatbot',
        tier: 'pro',
        stripeRecurringPriceId: 'price_recurring_1',
        stripeSetupPriceId: 'price_setup_1',
        setupFeeCents: 39900,
        priceCents: 24900,
        currency: 'EUR',
      },
    });

    const { POST } = await import('@/app/api/admin/portal/billing/checkout/route');
    const res = await POST(makeRequest({ clientProductId: '11111111-1111-1111-1111-111111111111' }));

    expect(res.status).toBe(201);
    expect(mockState.subscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [{ price: 'price_recurring_1' }],
        add_invoice_items: [{ price: 'price_setup_1' }],
      }),
    );
  });

  it('omits add_invoice_items entirely for a product with no setup fee', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce({
      ...BASE_CLIENT_PRODUCT,
      product: {
        id: 'prod_2',
        code: 'seo',
        tier: 'standard',
        stripeRecurringPriceId: 'price_seo_1',
        stripeSetupPriceId: null,
        setupFeeCents: 0,
        priceCents: 19900,
        currency: 'EUR',
      },
    });

    const { POST } = await import('@/app/api/admin/portal/billing/checkout/route');
    const res = await POST(makeRequest({ clientProductId: '11111111-1111-1111-1111-111111111111' }));

    expect(res.status).toBe(201);
    const call = mockState.subscriptionsCreate.mock.calls[0][0];
    expect(call).not.toHaveProperty('add_invoice_items');
  });
});

describe('POST /api/admin/portal/billing/checkout — recurring subscription date bug (WP-19)', () => {
  it('writes null (not 1970-01-01) for current_period_start/end when Stripe has not populated them yet', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce({
      ...BASE_CLIENT_PRODUCT,
      product: {
        id: 'prod_1',
        code: 'chatbot',
        tier: 'pro',
        stripeRecurringPriceId: 'price_recurring_1',
        stripeSetupPriceId: null,
        setupFeeCents: 0,
        priceCents: 24900,
        currency: 'EUR',
      },
    });

    const { POST } = await import('@/app/api/admin/portal/billing/checkout/route');
    const res = await POST(makeRequest({ clientProductId: '11111111-1111-1111-1111-111111111111' }));

    expect(res.status).toBe(201);
    expect(mockState.subscriptionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          currentPeriodStart: null,
          currentPeriodEnd: null,
        }),
      }),
    );
  });

  it('still converts a populated current_period_end to a real Date', async () => {
    mockState.subscriptionsCreate.mockResolvedValueOnce({
      id: 'sub_stripe_2',
      status: 'active',
      cancel_at_period_end: false,
      metadata: {},
      current_period_start: 1723600000,
      current_period_end: 1726192000,
    });
    mockState.findUniqueClientProduct.mockResolvedValueOnce({
      ...BASE_CLIENT_PRODUCT,
      product: {
        id: 'prod_1',
        code: 'chatbot',
        tier: 'pro',
        stripeRecurringPriceId: 'price_recurring_1',
        stripeSetupPriceId: null,
        setupFeeCents: 0,
        priceCents: 24900,
        currency: 'EUR',
      },
    });

    const { POST } = await import('@/app/api/admin/portal/billing/checkout/route');
    await POST(makeRequest({ clientProductId: '11111111-1111-1111-1111-111111111111' }));

    const call = mockState.subscriptionUpsert.mock.calls[0][0];
    expect(call.create.currentPeriodStart).toEqual(new Date(1723600000 * 1000));
    expect(call.create.currentPeriodEnd).toEqual(new Date(1726192000 * 1000));
  });
});

describe('POST /api/admin/portal/billing/checkout — one-time-purchase products (WP-19)', () => {
  const ONE_TIME_PRODUCT = {
    id: 'prod_web',
    code: 'web',
    tier: 'standard',
    stripeRecurringPriceId: null,
    stripeSetupPriceId: 'price_setup_web_1',
    setupFeeCents: 79900,
    priceCents: 0,
    currency: 'EUR',
  };

  it('creates a one-off Invoice, never a Subscription, for a product with no recurring price', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce({
      ...BASE_CLIENT_PRODUCT,
      product: ONE_TIME_PRODUCT,
    });
    mockState.createOneTimeInvoice.mockResolvedValueOnce({
      id: 'in_stripe_1',
      status: 'open',
      hosted_invoice_url: 'https://invoice.stripe.com/i/in_stripe_1',
    });
    mockState.findUniqueOrThrowInvoice.mockResolvedValueOnce({
      id: 'inv_row_1',
      status: 'open',
      hostInvoiceUrl: 'https://invoice.stripe.com/i/in_stripe_1',
    });

    const { POST } = await import('@/app/api/admin/portal/billing/checkout/route');
    const res = await POST(makeRequest({ clientProductId: '11111111-1111-1111-1111-111111111111' }));
    const body = await res.clone().json();

    expect(res.status).toBe(201);
    expect(body).toMatchObject({
      invoiceId: 'inv_row_1',
      stripeInvoiceId: 'in_stripe_1',
      stripeCustomerId: 'cus_123',
      status: 'open',
      hostInvoiceUrl: 'https://invoice.stripe.com/i/in_stripe_1',
    });
    expect(mockState.subscriptionsCreate).not.toHaveBeenCalled();
    expect(mockState.createOneTimeInvoice).toHaveBeenCalledWith({
      clientProductId: 'cp_1',
      stripeCustomerId: 'cus_123',
      stripeSetupPriceId: 'price_setup_web_1',
      metadata: expect.objectContaining({ kairikos_client_product_id: 'cp_1' }),
    });
    expect(mockState.syncInvoiceFromStripe).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'in_stripe_1' }),
    );
  });

  it('refuses with 404 when a one-time-only product has neither a recurring price nor a setup fee', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce({
      ...BASE_CLIENT_PRODUCT,
      product: { ...ONE_TIME_PRODUCT, stripeSetupPriceId: null, setupFeeCents: 0 },
    });

    const { POST } = await import('@/app/api/admin/portal/billing/checkout/route');
    const res = await POST(makeRequest({ clientProductId: '11111111-1111-1111-1111-111111111111' }));
    const body = await res.clone().json();

    expect(res.status).toBe(404);
    expect(body.error).toBe('product_price_id_missing');
    expect(mockState.createOneTimeInvoice).not.toHaveBeenCalled();
    expect(mockState.subscriptionsCreate).not.toHaveBeenCalled();
  });

  it('refuses with 404 when a one-time-only product has a fee but no Stripe setup price provisioned', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce({
      ...BASE_CLIENT_PRODUCT,
      product: { ...ONE_TIME_PRODUCT, stripeSetupPriceId: null },
    });

    const { POST } = await import('@/app/api/admin/portal/billing/checkout/route');
    const res = await POST(makeRequest({ clientProductId: '11111111-1111-1111-1111-111111111111' }));
    const body = await res.clone().json();

    expect(res.status).toBe(404);
    expect(body.error).toBe('product_setup_price_id_missing');
    expect(mockState.createOneTimeInvoice).not.toHaveBeenCalled();
  });
});
