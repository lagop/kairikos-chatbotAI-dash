// =============================================================================
// Unit tests for the remaining Stripe catalog settings routes:
// POST .../products/[productId]/bootstrap
// POST .../stripe/active-mode
// POST .../products/[productId]/reconcile
// GET  .../products/[productId]/impact
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  requireTotpStepUp: vi.fn(),
  isStripeConfigured: vi.fn(),
  findUniqueProduct: vi.fn(),
  findUniqueOperator: vi.fn(),
  bootstrapStripeProductForTier: vi.fn(),
  reconcileStripeProductForTier: vi.fn(),
  countActiveSubscriptionsForProduct: vi.fn(),
  getStripeCredentialStatus: vi.fn(),
  setActiveStripeMode: vi.fn(),
}));

vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...args: unknown[]) => mockState.authenticateAdminRequest(...args),
}));

vi.mock('@/lib/operator-totp-stepup', () => ({
  requireTotpStepUp: (...args: unknown[]) => mockState.requireTotpStepUp(...args),
}));

vi.mock('@/lib/stripe', () => ({
  isStripeConfigured: (...args: unknown[]) => mockState.isStripeConfigured(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    product: { findUnique: (...args: unknown[]) => mockState.findUniqueProduct(...args) },
    operator: { findUnique: (...args: unknown[]) => mockState.findUniqueOperator(...args) },
  },
  isDatabaseConfigured: true,
}));

vi.mock('@/lib/stripe-catalog', () => ({
  bootstrapStripeProductForTier: (...args: unknown[]) => mockState.bootstrapStripeProductForTier(...args),
  reconcileStripeProductForTier: (...args: unknown[]) => mockState.reconcileStripeProductForTier(...args),
  countActiveSubscriptionsForProduct: (...args: unknown[]) => mockState.countActiveSubscriptionsForProduct(...args),
}));

vi.mock('@/lib/stripe-credentials', () => ({
  getStripeCredentialStatus: (...args: unknown[]) => mockState.getStripeCredentialStatus(...args),
  setActiveStripeMode: (...args: unknown[]) => mockState.setActiveStripeMode(...args),
}));

const AUTH_OK = { ok: true, sessionId: 's1', operatorId: 'op_1' };
const STEP_UP_OK = { ok: true, operatorId: 'op_1', sessionId: 's1' };

function makeRequest(body: unknown = {}) {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue(AUTH_OK);
  mockState.requireTotpStepUp.mockReset().mockResolvedValue(STEP_UP_OK);
  mockState.isStripeConfigured.mockReset().mockResolvedValue(true);
  mockState.findUniqueProduct.mockReset().mockResolvedValue({ id: 'prod_1' });
  mockState.findUniqueOperator.mockReset().mockResolvedValue({ email: 'lucia@kairikos.com' });
  mockState.bootstrapStripeProductForTier.mockReset();
  mockState.reconcileStripeProductForTier.mockReset();
  mockState.countActiveSubscriptionsForProduct.mockReset();
  mockState.getStripeCredentialStatus.mockReset();
  mockState.setActiveStripeMode.mockReset();
});

describe('POST .../products/[productId]/bootstrap', () => {
  async function callRoute() {
    const { POST } = await import('@/app/api/admin/portal/settings/products/[productId]/bootstrap/route');
    return POST(makeRequest(), { params: { productId: 'prod_1' } });
  }

  it('403s without TOTP step-up', async () => {
    mockState.requireTotpStepUp.mockResolvedValueOnce({ ok: false, status: 403, error: 'totp_step_up_required' });
    const res = await callRoute();
    expect(res.status).toBe(403);
    expect(mockState.bootstrapStripeProductForTier).not.toHaveBeenCalled();
  });

  it('503s when no Stripe credential is configured', async () => {
    mockState.isStripeConfigured.mockResolvedValueOnce(false);
    const res = await callRoute();
    expect(res.status).toBe(503);
  });

  it('409s already_bootstrapped', async () => {
    mockState.bootstrapStripeProductForTier.mockResolvedValueOnce({ ok: false, error: { kind: 'already_bootstrapped' } });
    const res = await callRoute();
    expect(res.status).toBe(409);
  });

  it('200s on success', async () => {
    mockState.bootstrapStripeProductForTier.mockResolvedValueOnce({ ok: true, product: { id: 'prod_1' } });
    const res = await callRoute();
    expect(res.status).toBe(200);
  });

  it('500s cleanly, rather than crashing, when the tier decrypt/create throws', async () => {
    // Regression: bootstrapStripeProductForTier decrypts the stored
    // Stripe key via resolveActiveStripeSecret(). A misconfigured
    // STRIPE_CREDENTIAL_ENCRYPTION_KEY throws synchronously there,
    // unguarded — same class of crash as the credentials route.
    mockState.bootstrapStripeProductForTier.mockRejectedValueOnce(
      new Error('STRIPE_CREDENTIAL_ENCRYPTION_KEY is not set'),
    );
    const res = await callRoute();
    expect(res.status).toBe(500);
    expect(await res.clone().json()).toEqual({ error: 'internal_error' });
  });
});

describe('POST .../stripe/active-mode', () => {
  async function callRoute(mode: string) {
    const { POST } = await import('@/app/api/admin/portal/settings/stripe/active-mode/route');
    return POST(makeRequest({ mode }));
  }

  it('403s without TOTP step-up', async () => {
    mockState.requireTotpStepUp.mockResolvedValueOnce({ ok: false, status: 403, error: 'totp_step_up_required' });
    const res = await callRoute('live');
    expect(res.status).toBe(403);
    expect(mockState.setActiveStripeMode).not.toHaveBeenCalled();
  });

  it('409s when the target mode has no credential configured yet', async () => {
    mockState.getStripeCredentialStatus.mockResolvedValueOnce({
      activeMode: null,
      test: { configured: true, lastFour: 'abcd', savedAt: null },
      live: { configured: false, lastFour: null, savedAt: null },
    });
    const res = await callRoute('live');
    expect(res.status).toBe(409);
    expect(mockState.setActiveStripeMode).not.toHaveBeenCalled();
  });

  it('200s and switches the mode when configured', async () => {
    mockState.getStripeCredentialStatus.mockResolvedValueOnce({
      activeMode: null,
      test: { configured: true, lastFour: 'abcd', savedAt: null },
      live: { configured: false, lastFour: null, savedAt: null },
    });
    const res = await callRoute('test');
    expect(res.status).toBe(200);
    expect(mockState.setActiveStripeMode).toHaveBeenCalledWith('test', { operatorId: 'op_1', operatorEmail: 'lucia@kairikos.com' });
  });
});

describe('POST .../products/[productId]/reconcile', () => {
  it('403s without TOTP step-up', async () => {
    mockState.requireTotpStepUp.mockResolvedValueOnce({ ok: false, status: 403, error: 'totp_step_up_required' });
    const { POST } = await import('@/app/api/admin/portal/settings/products/[productId]/reconcile/route');
    const res = await POST(makeRequest({ stripeProductId: 'p1' }), { params: { productId: 'prod_1' } });
    expect(res.status).toBe(403);
    expect(mockState.reconcileStripeProductForTier).not.toHaveBeenCalled();
  });

  it('persists the given ids without re-touching Stripe', async () => {
    mockState.reconcileStripeProductForTier.mockResolvedValueOnce({ ok: true, product: { id: 'prod_1', stripeProductId: 'p1' } });
    const { POST } = await import('@/app/api/admin/portal/settings/products/[productId]/reconcile/route');
    const res = await POST(
      makeRequest({ stripeProductId: 'p1', stripeRecurringPriceId: 'price1', stripeSetupPriceId: null }),
      { params: { productId: 'prod_1' } },
    );
    expect(res.status).toBe(200);
    expect(mockState.reconcileStripeProductForTier).toHaveBeenCalledWith(
      'prod_1',
      { stripeProductId: 'p1', stripeRecurringPriceId: 'price1', stripeSetupPriceId: null },
      { operatorId: 'op_1', operatorEmail: 'lucia@kairikos.com' },
    );
  });
});

describe('GET .../products/[productId]/impact', () => {
  it('does not require TOTP step-up (read-only)', async () => {
    mockState.countActiveSubscriptionsForProduct.mockResolvedValueOnce(5);
    const { GET } = await import('@/app/api/admin/portal/settings/products/[productId]/impact/route');
    const res = await GET({} as NextRequest, { params: { productId: 'prod_1' } });
    expect(res.status).toBe(200);
    expect(await res.clone().json()).toEqual({ activeSubscriptions: 5 });
    expect(mockState.requireTotpStepUp).not.toHaveBeenCalled();
  });

  it('404s when the product does not exist', async () => {
    mockState.findUniqueProduct.mockResolvedValueOnce(null);
    const { GET } = await import('@/app/api/admin/portal/settings/products/[productId]/impact/route');
    const res = await GET({} as NextRequest, { params: { productId: 'missing' } });
    expect(res.status).toBe(404);
  });
});
