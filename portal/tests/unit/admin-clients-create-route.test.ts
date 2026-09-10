// =============================================================================
// POST /api/admin/portal/clients — alta manual de cliente.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  createClientByOperator: vi.fn(),
  activateClientProductForOperator: vi.fn(),
  createProductCheckoutSession: vi.fn(),
  findUniqueProduct: vi.fn(),
  sendSetupPassword: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...args: unknown[]) => mockState.authenticateAdminRequest(...args),
}));

vi.mock('@/lib/admin-client-onboarding', () => ({
  createClientByOperator: (...args: unknown[]) => mockState.createClientByOperator(...args),
}));

vi.mock('@/lib/client-product-activation', () => ({
  activateClientProductForOperator: (...args: unknown[]) => mockState.activateClientProductForOperator(...args),
}));

vi.mock('@/lib/stripe-billing', () => ({
  createProductCheckoutSession: (...args: unknown[]) => mockState.createProductCheckoutSession(...args),
}));

vi.mock('@/lib/auth-email', () => ({
  sendSetupPassword: (...args: unknown[]) => mockState.sendSetupPassword(...args),
  sendEmail: (...args: unknown[]) => mockState.sendEmail(...args),
}));

vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));

vi.mock('@/lib/supabase', () => ({ isBackendConfigured: false, PORTAL_API_BASE_URL: '' }));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    product: { findUnique: (...args: unknown[]) => mockState.findUniqueProduct(...args) },
  },
  isDatabaseConfigured: true,
}));

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof import('@/app/api/admin/portal/clients/route').POST>[0];
}

const PRODUCT_A = '11111111-1111-1111-1111-111111111111';
const PRODUCT_B = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue({ ok: true, operatorId: 'op_1' });
  mockState.createClientByOperator.mockReset().mockResolvedValue({ ok: true, clientId: 'client_1', clientUserId: 'cu_1', isNewClient: true });
  mockState.activateClientProductForOperator.mockReset().mockResolvedValue({ ok: true, clientProductId: 'cp_1', productCode: 'seo', wasReactivated: false });
  mockState.createProductCheckoutSession.mockReset().mockResolvedValue({ ok: true, url: 'https://checkout.stripe.com/pay/cs_1' });
  mockState.findUniqueProduct.mockReset().mockResolvedValue({ name: 'SEO con IA' });
  mockState.sendSetupPassword.mockReset().mockResolvedValue(undefined);
  mockState.sendEmail.mockReset().mockResolvedValue(undefined);
});

describe('POST /api/admin/portal/clients — auth and validation', () => {
  it('403s when the caller is not an authenticated operator', async () => {
    mockState.authenticateAdminRequest.mockResolvedValueOnce({ ok: false });
    const { POST } = await import('@/app/api/admin/portal/clients/route');
    const res = await POST(makeRequest({ email: 'a@b.com', name: 'A', companyName: 'B' }));
    expect(res.status).toBe(403);
    expect(mockState.createClientByOperator).not.toHaveBeenCalled();
  });

  it('400s on an invalid body', async () => {
    const { POST } = await import('@/app/api/admin/portal/clients/route');
    const res = await POST(makeRequest({ email: 'not-an-email' }));
    expect(res.status).toBe(400);
    expect(mockState.createClientByOperator).not.toHaveBeenCalled();
  });

  it('409s when the client already exists', async () => {
    mockState.createClientByOperator.mockResolvedValueOnce({ ok: false, error: 'client_already_exists' });
    const { POST } = await import('@/app/api/admin/portal/clients/route');
    const res = await POST(makeRequest({ email: 'a@b.com', name: 'A', companyName: 'B' }));
    expect(res.status).toBe(409);
  });
});

describe('POST /api/admin/portal/clients — creating with products', () => {
  it('creates the client with no products and still sends the setup email', async () => {
    const { POST } = await import('@/app/api/admin/portal/clients/route');
    const res = await POST(makeRequest({ email: 'a@b.com', name: 'A', companyName: 'B' }));
    const body = await res.clone().json();

    expect(res.status).toBe(201);
    expect(body.clientId).toBe('client_1');
    expect(body.activated).toEqual([]);
    expect(body.checkoutLinksSent).toBe(0);
    expect(mockState.sendSetupPassword).toHaveBeenCalledWith(expect.objectContaining({ to: 'a@b.com' }));
  });

  it("activates a product directly for mode='active' without touching Stripe", async () => {
    const { POST } = await import('@/app/api/admin/portal/clients/route');
    const res = await POST(
      makeRequest({ email: 'a@b.com', name: 'A', companyName: 'B', products: [{ productId: PRODUCT_A, mode: 'active' }] }),
    );
    const body = await res.clone().json();

    expect(res.status).toBe(201);
    expect(body.activated).toEqual(['seo']);
    expect(mockState.activateClientProductForOperator).toHaveBeenCalledWith(
      expect.anything(),
      { clientId: 'client_1', productId: PRODUCT_A },
      { operatorId: 'op_1' },
    );
    expect(mockState.createProductCheckoutSession).not.toHaveBeenCalled();
    expect(mockState.sendEmail).not.toHaveBeenCalled();
  });

  it("resolves the legacy operator to null for the ClientProduct actor, same as the existing client-products route", async () => {
    mockState.authenticateAdminRequest.mockResolvedValueOnce({ ok: true, operatorId: 'legacy' });
    const { POST } = await import('@/app/api/admin/portal/clients/route');
    await POST(makeRequest({ email: 'a@b.com', name: 'A', companyName: 'B', products: [{ productId: PRODUCT_A, mode: 'active' }] }));

    expect(mockState.activateClientProductForOperator).toHaveBeenCalledWith(expect.anything(), expect.anything(), { operatorId: null });
  });

  it("creates a Stripe checkout link for mode='checkout_link' and emails it to the client", async () => {
    const { POST } = await import('@/app/api/admin/portal/clients/route');
    const res = await POST(
      makeRequest({ email: 'a@b.com', name: 'A', companyName: 'B', products: [{ productId: PRODUCT_A, mode: 'checkout_link' }] }),
    );
    const body = await res.clone().json();

    expect(res.status).toBe(201);
    expect(body.checkoutLinksSent).toBe(1);
    expect(mockState.createProductCheckoutSession).toHaveBeenCalledWith({ clientId: 'client_1', productId: PRODUCT_A, actorId: 'operator:op_1' });
    expect(mockState.activateClientProductForOperator).not.toHaveBeenCalled();
    expect(mockState.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'a@b.com', html: expect.stringContaining('https://checkout.stripe.com/pay/cs_1') }),
    );
  });

  it('handles a mix of active and checkout_link products in one request, and reports per-product failures without failing the whole request', async () => {
    mockState.activateClientProductForOperator.mockResolvedValueOnce({ ok: false, error: 'product_not_found' });
    const { POST } = await import('@/app/api/admin/portal/clients/route');
    const res = await POST(
      makeRequest({
        email: 'a@b.com',
        name: 'A',
        companyName: 'B',
        products: [
          { productId: PRODUCT_A, mode: 'active' },
          { productId: PRODUCT_B, mode: 'checkout_link' },
        ],
      }),
    );
    const body = await res.clone().json();

    expect(res.status).toBe(201);
    expect(body.activated).toEqual([]);
    expect(body.failed).toEqual([{ productId: PRODUCT_A, mode: 'active', error: 'product_not_found' }]);
    expect(body.checkoutLinksSent).toBe(1);
  });

  it('does not fail the whole request when the setup email fails to send', async () => {
    mockState.sendSetupPassword.mockRejectedValueOnce(new Error('resend_down'));
    const { POST } = await import('@/app/api/admin/portal/clients/route');
    const res = await POST(makeRequest({ email: 'a@b.com', name: 'A', companyName: 'B' }));
    expect(res.status).toBe(201);
  });
});
