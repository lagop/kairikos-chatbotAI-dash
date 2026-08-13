// =============================================================================
// WP-12 — unit tests for POST /api/admin/portal/billing/checkout.
//
// Covers the setup-fee handling this WP added: a Product can now carry a
// one-time setupFeeCents alongside its recurring priceCents. If there's a
// fee to charge, the route must refuse to create a subscription unless the
// fee's Stripe price is provisioned (stripeSetupPriceId) — otherwise the
// client would be silently undercharged — and when it IS provisioned, the
// fee rides along as an `add_invoice_items` entry on the same subscription
// create call.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  findUniqueClientProduct: vi.fn(),
  subscriptionUpsert: vi.fn(),
  ensureCustomerForTenant: vi.fn(),
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
  },
  isDatabaseConfigured: true,
}));

vi.mock('@/lib/stripe-billing', () => ({
  ensureCustomerForTenant: (...args: unknown[]) => mockState.ensureCustomerForTenant(...args),
}));

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
  mockState.isStripeConfigured.mockReset().mockReturnValue(true);
  mockState.subscriptionsCreate.mockReset().mockResolvedValue({
    id: 'sub_stripe_1',
    status: 'incomplete',
    cancel_at_period_end: false,
    metadata: {},
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
