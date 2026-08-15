// =============================================================================
// Unit tests for POST /api/admin/portal/settings/products/[productId]/reprice.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  requireTotpStepUp: vi.fn(),
  isStripeConfigured: vi.fn(),
  findUniqueProduct: vi.fn(),
  findUniqueOperator: vi.fn(),
  repriceStripeTier: vi.fn(),
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
  repriceStripeTier: (...args: unknown[]) => mockState.repriceStripeTier(...args),
}));

const AUTH_OK = { ok: true, sessionId: 's1', operatorId: 'op_1' };
const STEP_UP_OK = { ok: true, operatorId: 'op_1', sessionId: 's1' };
const VALID_BODY = {
  priceCents: 12900,
  setupFeeCents: null,
  expectedPriceCents: 9900,
  expectedSetupFeeCents: 9900,
};

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

async function callRoute(body: unknown) {
  const { POST } = await import('@/app/api/admin/portal/settings/products/[productId]/reprice/route');
  return POST(makeRequest(body), { params: { productId: 'prod_1' } });
}

beforeEach(() => {
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue(AUTH_OK);
  mockState.requireTotpStepUp.mockReset().mockResolvedValue(STEP_UP_OK);
  mockState.isStripeConfigured.mockReset().mockResolvedValue(true);
  mockState.findUniqueProduct.mockReset().mockResolvedValue({ id: 'prod_1' });
  mockState.findUniqueOperator.mockReset().mockResolvedValue({ email: 'lucia@kairikos.com' });
  mockState.repriceStripeTier.mockReset();
});

describe('POST /api/admin/portal/settings/products/[productId]/reprice', () => {
  it('403s without a real operator session', async () => {
    mockState.authenticateAdminRequest.mockResolvedValueOnce({ ok: false });
    const res = await callRoute(VALID_BODY);
    expect(res.status).toBe(401);
    expect(mockState.repriceStripeTier).not.toHaveBeenCalled();
  });

  it('403s without a fresh TOTP step-up, even with a valid operator session', async () => {
    mockState.requireTotpStepUp.mockResolvedValueOnce({ ok: false, status: 403, error: 'totp_step_up_required' });
    const res = await callRoute(VALID_BODY);
    expect(res.status).toBe(403);
    const body = await res.clone().json();
    expect(body.error).toBe('totp_step_up_required');
    expect(mockState.repriceStripeTier).not.toHaveBeenCalled();
  });

  it('400s an invalid body (negative price)', async () => {
    const res = await callRoute({ ...VALID_BODY, priceCents: -100 });
    expect(res.status).toBe(400);
    expect(mockState.repriceStripeTier).not.toHaveBeenCalled();
  });

  it('404s when the product does not exist', async () => {
    mockState.findUniqueProduct.mockResolvedValueOnce(null);
    const res = await callRoute(VALID_BODY);
    expect(res.status).toBe(404);
  });

  it('409s not_bootstrapped_yet', async () => {
    mockState.repriceStripeTier.mockResolvedValueOnce({ ok: false, error: { kind: 'not_bootstrapped_yet' } });
    const res = await callRoute(VALID_BODY);
    expect(res.status).toBe(409);
    expect((await res.clone().json()).error).toBe('not_bootstrapped_yet');
  });

  it('409s concurrent_modification', async () => {
    mockState.repriceStripeTier.mockResolvedValueOnce({ ok: false, error: { kind: 'concurrent_modification' } });
    const res = await callRoute(VALID_BODY);
    expect(res.status).toBe(409);
    expect((await res.clone().json()).error).toBe('concurrent_modification');
  });

  it('502s partial_failure and surfaces the orphaned Stripe ids', async () => {
    mockState.repriceStripeTier.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'partial_failure', stripeProductId: 'p1', stripeRecurringPriceId: 'price1', stripeSetupPriceId: null },
    });
    const res = await callRoute(VALID_BODY);
    expect(res.status).toBe(502);
    const body = await res.clone().json();
    expect(body.stripeProductId).toBe('p1');
  });

  it('200s on success and passes the actor through to repriceStripeTier', async () => {
    mockState.repriceStripeTier.mockResolvedValueOnce({ ok: true, product: { id: 'prod_1', priceCents: 12900 } });
    const res = await callRoute(VALID_BODY);
    expect(res.status).toBe(200);
    expect(mockState.repriceStripeTier).toHaveBeenCalledWith(
      expect.objectContaining({ productId: 'prod_1', newPriceCents: 12900 }),
      { operatorId: 'op_1', operatorEmail: 'lucia@kairikos.com' },
    );
  });
});
