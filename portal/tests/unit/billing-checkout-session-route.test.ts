// =============================================================================
// KAIA-10264 (H3) — Unit tests for POST /api/public/billing/checkout-session.
//
// Contract under test:
//
//   * Schema-valid bodies reach the downstream handler.
//   * `session_not_found` is returned when the OnboardingSession token
//     does not resolve to a row.
//   * `service_unavailable` (503) is returned when Stripe is not
//     configured (preview / dev with no key).
//   * `service_unavailable` (503) is returned when the database is not
//     configured.
//   * KAIA-10264 H3 — when the downstream handler throws unexpectedly
//     (e.g. Stripe rejecting the customer, a transient Prisma error,
//     an invalid metadata value), the route MUST return HTTP 500 with
//     a JSON body that includes the thrown message instead of Next.js'
//     default empty-body 500.
//
// Prisma, the onboarding sessions helper, and Stripe are all mocked.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getOnboardingSession = vi.fn();
const updateOnboardingSession = vi.fn();
const markCheckoutStarted = vi.fn();
const findUniqueProduct = vi.fn();
const findUniqueTenant = vi.fn();
const createTenant = vi.fn();
const findFirstClient = vi.fn();
const createClient = vi.fn();
const findUniqueClientProduct = vi.fn();
const createClientProduct = vi.fn();
const updateTenant = vi.fn();
const isStripeConfigured = vi.fn();
const getStripe = vi.fn();
const stripeCustomerCreate = vi.fn();
const stripeCheckoutCreate = vi.fn();

vi.mock('@/lib/onboarding/sessions', () => ({
  getOnboardingSession: (...args: unknown[]) => getOnboardingSession(...args),
  updateOnboardingSession: (...args: unknown[]) => updateOnboardingSession(...args),
  markCheckoutStarted: (...args: unknown[]) => markCheckoutStarted(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    product: { findUnique: (...args: unknown[]) => findUniqueProduct(...args) },
    tenant: {
      findUnique: (...args: unknown[]) => findUniqueTenant(...args),
      create: (...args: unknown[]) => createTenant(...args),
      update: (...args: unknown[]) => updateTenant(...args),
    },
    chatbotClient: {
      findFirst: (...args: unknown[]) => findFirstClient(...args),
      create: (...args: unknown[]) => createClient(...args),
    },
    clientProduct: {
      findUnique: (...args: unknown[]) => findUniqueClientProduct(...args),
      create: (...args: unknown[]) => createClientProduct(...args),
    },
  },
  isDatabaseConfigured: true,
}));

vi.mock('@/lib/stripe', () => ({
  isStripeConfigured: () => isStripeConfigured(),
  getStripe: () => getStripe(),
}));

import { POST } from '@/app/api/public/billing/checkout-session/route';

const KNOWN_SESSION_ID = 'session-known-001';
const KNOWN_TENANT_ID = 'tenant-known-001';
const KNOWN_CLIENT_ID = 'client-known-001';
const KNOWN_CLIENT_PRODUCT_ID = 'cp-known-001';
const KNOWN_PRODUCT_ID = 'product-known-001';
const KNOWN_STRIPE_CUSTOMER = 'cus_test_001';
const KNOWN_CHECKOUT_ID = 'cs_test_001';
const KNOWN_CHECKOUT_URL = 'https://stripe.test/c/cs_test_001';

function validBody() {
  return {
    sessionId: KNOWN_SESSION_ID,
    productTier: 'starter',
    email: 'qa@example.com',
    config: {
      businessName: 'Aurora Test SL',
      sector: 'asesoria',
    },
  };
}

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return {
    json: async () => body,
    headers: {
      get: (name: string) => {
        const lower = name.toLowerCase();
        for (const [k, v] of Object.entries(headers)) {
          if (k.toLowerCase() === lower) return v;
        }
        return null;
      },
    },
  } as unknown as Parameters<typeof POST>[0];
}

async function bodyOf(res: Response): Promise<{ status: number; body: any }> {
  const clone = res.clone();
  const body = await clone.json();
  return { status: res.status, body };
}

function happyPathMocks() {
  isStripeConfigured.mockReturnValue(true);
  getOnboardingSession.mockResolvedValue({
    sessionToken: KNOWN_SESSION_ID,
    email: 'qa@example.com',
    tenantSlug: 'aurora-test-sl',
    productTier: null,
    productId: null,
    clientProductId: null,
    businessName: null,
    sector: null,
    whatsapp: null,
    contactEmail: null,
    stripeCheckoutSessionId: null,
    clientId: null,
    tenantId: null,
    status: 'pending',
    activationAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  findUniqueProduct.mockResolvedValue({
    id: KNOWN_PRODUCT_ID,
    name: 'Starter',
    tier: 'starter',
    stripePriceId: 'price_test_starter',
    priceCents: 9900,
    currency: 'EUR',
  });
  findUniqueTenant.mockResolvedValue({
    id: KNOWN_TENANT_ID,
    stripeCustomerId: null,
  });
  findFirstClient.mockResolvedValue({
    id: KNOWN_CLIENT_ID,
  });
  findUniqueClientProduct.mockResolvedValue({
    id: KNOWN_CLIENT_PRODUCT_ID,
  });
  updateOnboardingSession.mockResolvedValue(undefined);
  createTenant.mockResolvedValue({ id: KNOWN_TENANT_ID, stripeCustomerId: null });
  createClient.mockResolvedValue({ id: KNOWN_CLIENT_ID });
  createClientProduct.mockResolvedValue({ id: KNOWN_CLIENT_PRODUCT_ID });
  updateTenant.mockResolvedValue({ id: KNOWN_TENANT_ID, stripeCustomerId: KNOWN_STRIPE_CUSTOMER });
  stripeCustomerCreate.mockResolvedValue({ id: KNOWN_STRIPE_CUSTOMER });
  stripeCheckoutCreate.mockResolvedValue({ id: KNOWN_CHECKOUT_ID, url: KNOWN_CHECKOUT_URL });
  getStripe.mockReturnValue({
    customers: { create: stripeCustomerCreate },
    checkout: { sessions: { create: stripeCheckoutCreate } },
  });
  markCheckoutStarted.mockResolvedValue(undefined);
}

beforeEach(() => {
  [
    getOnboardingSession, updateOnboardingSession, markCheckoutStarted,
    findUniqueProduct, findUniqueTenant, createTenant, findFirstClient,
    createClient, findUniqueClientProduct, createClientProduct, updateTenant,
    isStripeConfigured, getStripe, stripeCustomerCreate, stripeCheckoutCreate,
  ].forEach((fn) => fn.mockReset());
});

describe('POST /api/public/billing/checkout-session — KAIA-10264 H3', () => {
  it('400s on invalid JSON body', async () => {
    const res = await POST(makeRequest(null));
    const { status, body } = await bodyOf(res);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_body');
  });

  it('400s on schema-invalid body (missing sessionId)', async () => {
    const res = await POST(
      makeRequest({ productTier: 'starter', email: 'qa@example.com', config: validBody().config }),
    );
    const { status, body } = await bodyOf(res);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_body');
  });

  it('503s with stripe_not_configured when STRIPE_SECRET_KEY is unset', async () => {
    isStripeConfigured.mockReturnValue(false);
    const res = await POST(makeRequest(validBody()));
    const { status, body } = await bodyOf(res);
    expect(status).toBe(503);
    expect(body).toEqual({ error: 'service_unavailable', detail: 'stripe_not_configured' });
  });

  it('404s with session_not_found when the OnboardingSession does not exist', async () => {
    isStripeConfigured.mockReturnValue(true);
    getOnboardingSession.mockResolvedValue(null);
    const res = await POST(makeRequest(validBody()));
    const { status, body } = await bodyOf(res);
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'session_not_found' });
  });

  it('happy path returns 200 with checkoutUrl / clientProductId / stripeSessionId', async () => {
    happyPathMocks();
    const res = await POST(makeRequest(validBody()));
    const { status, body } = await bodyOf(res);
    expect(status).toBe(200);
    expect(body).toEqual({
      checkoutUrl: KNOWN_CHECKOUT_URL,
      clientProductId: KNOWN_CLIENT_PRODUCT_ID,
      stripeSessionId: KNOWN_CHECKOUT_ID,
    });
    expect(markCheckoutStarted).toHaveBeenCalledTimes(1);
  });

  it('KAIA-10264 H3: unexpected throw in the downstream handler returns 500 with JSON body carrying the error message', async () => {
    isStripeConfigured.mockReturnValue(true);
    getOnboardingSession.mockResolvedValue({
      sessionToken: KNOWN_SESSION_ID,
      email: 'qa@example.com',
      tenantSlug: 'aurora-test-sl',
      productTier: null,
      productId: null,
      clientProductId: null,
      businessName: null,
      sector: null,
      whatsapp: null,
      contactEmail: null,
      stripeCheckoutSessionId: null,
      clientId: null,
      tenantId: null,
      status: 'pending',
      activationAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    findUniqueProduct.mockImplementation(() => {
      throw new Error('Prisma client unavailable: ECONNRESET');
    });

    const res = await POST(makeRequest(validBody()));
    const { status, body } = await bodyOf(res);
    expect(status).toBe(500);
    expect(body.error).toBe('service_unavailable');
    expect(body.detail).toBe('Prisma client unavailable: ECONNRESET');
  });

  it('KAIA-10264 H3: Stripe customer.create rejection still surfaces as a JSON 500, not an empty body', async () => {
    happyPathMocks();
    stripeCustomerCreate.mockRejectedValue(new Error('No such customer: cus_invalid'));
    const res = await POST(makeRequest(validBody()));
    const { status, body } = await bodyOf(res);
    expect(status).toBe(500);
    expect(body.error).toBe('service_unavailable');
    expect(body.detail).toBe('No such customer: cus_invalid');
  });
});
