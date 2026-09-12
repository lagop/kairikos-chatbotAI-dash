// =============================================================================
// WP-30 — unit tests for POST /api/portal/billing/checkout, the client-
// facing self-serve checkout route.
//
// Refactored (misma sesión que POST /api/admin/portal/clients) para
// delegar toda la lógica de creación de la Checkout Session a
// createProductCheckoutSession (src/lib/stripe-billing.ts) — esta suite
// ya no cubre esa lógica en detalle, solo lo que sigue siendo
// responsabilidad de la ruta: sesión/auth, validación del body, y el
// mapeo de cada error a su código HTTP. La cobertura detallada de la
// creación de la sesión vive ahora en
// tests/unit/stripe-billing-checkout-session.test.ts.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  resolveClientFromSession: vi.fn(),
  getSession: vi.fn(),
  createProductCheckoutSession: vi.fn(),
  findUniqueProduct: vi.fn(),
}));

vi.mock('@/lib/portal-session', () => ({
  resolveClientFromSession: (...args: unknown[]) => mockState.resolveClientFromSession(...args),
}));

vi.mock('@/lib/session', () => ({
  getSession: (...args: unknown[]) => mockState.getSession(...args),
}));

vi.mock('@/lib/prisma', () => ({
  isDatabaseConfigured: true,
  prisma: { product: { findUnique: (...args: unknown[]) => mockState.findUniqueProduct(...args) } },
}));

vi.mock('@/lib/stripe-billing', () => ({
  createProductCheckoutSession: (...args: unknown[]) => mockState.createProductCheckoutSession(...args),
}));

function makeRequest(body: unknown) {
  return {
    json: async () => body,
    nextUrl: { origin: 'https://portal.kairikos.test' },
  } as unknown as Parameters<typeof import('@/app/api/portal/billing/checkout/route').POST>[0];
}

const RESOLVED = { clientId: 'client_1', email: 'a@b.com', source: 'database' as const };
const PRODUCT_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  mockState.resolveClientFromSession.mockReset().mockResolvedValue(RESOLVED);
  mockState.getSession.mockReset().mockResolvedValue({ hasClientAccess: true });
  mockState.createProductCheckoutSession.mockReset().mockResolvedValue({ ok: true, url: 'https://checkout.stripe.com/pay/cs_test_1' });
  mockState.findUniqueProduct.mockReset().mockResolvedValue({ selfServeEligible: true });
});

describe('POST /api/portal/billing/checkout — auth and guards', () => {
  it('401s when there is no client access on the session', async () => {
    mockState.getSession.mockResolvedValueOnce({ hasClientAccess: false });
    const { POST } = await import('@/app/api/portal/billing/checkout/route');
    const res = await POST(makeRequest({ productId: PRODUCT_ID }));
    expect(res.status).toBe(401);
    expect(mockState.createProductCheckoutSession).not.toHaveBeenCalled();
  });

  it('401s when there is no resolved client session', async () => {
    mockState.resolveClientFromSession.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/portal/billing/checkout/route');
    const res = await POST(makeRequest({ productId: PRODUCT_ID }));
    expect(res.status).toBe(401);
    expect(mockState.createProductCheckoutSession).not.toHaveBeenCalled();
  });

  it('503s for a dev-mock session — no real payment can be collected', async () => {
    mockState.resolveClientFromSession.mockResolvedValueOnce({ ...RESOLVED, source: 'mock_dev' });
    const { POST } = await import('@/app/api/portal/billing/checkout/route');
    const res = await POST(makeRequest({ productId: PRODUCT_ID }));
    expect(res.status).toBe(503);
    expect(mockState.createProductCheckoutSession).not.toHaveBeenCalled();
  });

  it('400s on an invalid body (missing/malformed productId)', async () => {
    const { POST } = await import('@/app/api/portal/billing/checkout/route');
    const res = await POST(makeRequest({ productId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
    expect(mockState.createProductCheckoutSession).not.toHaveBeenCalled();
  });
});

describe('POST /api/portal/billing/checkout — delegation and status mapping', () => {
  it('calls createProductCheckoutSession with the session clientId and a client:<id> actor', async () => {
    const { POST } = await import('@/app/api/portal/billing/checkout/route');
    await POST(makeRequest({ productId: PRODUCT_ID }));
    expect(mockState.createProductCheckoutSession).toHaveBeenCalledWith({
      clientId: 'client_1',
      productId: PRODUCT_ID,
      actorId: 'client:client_1',
    });
  });

  it('200s with the checkout URL on success', async () => {
    const { POST } = await import('@/app/api/portal/billing/checkout/route');
    const res = await POST(makeRequest({ productId: PRODUCT_ID }));
    const body = await res.clone().json();
    expect(res.status).toBe(200);
    expect(body.url).toBe('https://checkout.stripe.com/pay/cs_test_1');
  });

  it.each([
    ['product_not_found', 404],
    ['product_requires_quote', 400],
    ['requires_chatbot', 400],
    ['already_contracted', 409],
    ['stripe_error', 502],
  ] as const)('maps error=%s to HTTP %d', async (error, status) => {
    mockState.createProductCheckoutSession.mockResolvedValueOnce({ ok: false, error });
    const { POST } = await import('@/app/api/portal/billing/checkout/route');
    const res = await POST(makeRequest({ productId: PRODUCT_ID }));
    const body = await res.clone().json();
    expect(res.status).toBe(status);
    expect(body.error).toBe(error);
  });

  it("maps a 503-class error to its own detail (e.g. stripe_not_configured)", async () => {
    mockState.createProductCheckoutSession.mockResolvedValueOnce({ ok: false, error: 'stripe_not_configured' });
    const { POST } = await import('@/app/api/portal/billing/checkout/route');
    const res = await POST(makeRequest({ productId: PRODUCT_ID }));
    const body = await res.clone().json();
    expect(res.status).toBe(503);
    expect(body.detail).toBe('stripe_not_configured');
  });
});

describe('POST /api/portal/billing/checkout — self-serve eligibility gate', () => {
  it('400s with product_not_self_serve_eligible for a real product an operator has to assign by hand (e.g. recall)', async () => {
    mockState.findUniqueProduct.mockResolvedValueOnce({ selfServeEligible: false });
    const { POST } = await import('@/app/api/portal/billing/checkout/route');
    const res = await POST(makeRequest({ productId: PRODUCT_ID }));
    const body = await res.clone().json();
    expect(res.status).toBe(400);
    expect(body.error).toBe('product_not_self_serve_eligible');
    expect(mockState.createProductCheckoutSession).not.toHaveBeenCalled();
  });

  it('lets a genuinely missing productId fall through to product_not_found (404), not this gate', async () => {
    mockState.findUniqueProduct.mockResolvedValueOnce(null);
    mockState.createProductCheckoutSession.mockResolvedValueOnce({ ok: false, error: 'product_not_found' });
    const { POST } = await import('@/app/api/portal/billing/checkout/route');
    const res = await POST(makeRequest({ productId: PRODUCT_ID }));
    const body = await res.clone().json();
    expect(res.status).toBe(404);
    expect(body.error).toBe('product_not_found');
    expect(mockState.createProductCheckoutSession).toHaveBeenCalled();
  });

  it('proceeds to checkout as normal when the product is self-serve eligible', async () => {
    const { POST } = await import('@/app/api/portal/billing/checkout/route');
    const res = await POST(makeRequest({ productId: PRODUCT_ID }));
    expect(res.status).toBe(200);
    expect(mockState.createProductCheckoutSession).toHaveBeenCalled();
  });
});
