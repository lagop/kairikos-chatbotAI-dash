// =============================================================================
// Unit tests for POST /api/admin/portal/settings/products/[productId]/draft-price.
//
// The pre-bootstrap sibling of reprice: sets the price a tier will be
// CREATED with, before it has ever touched Stripe. No isStripeConfigured
// check — the whole point is that this works even with no Stripe key
// saved yet, since nothing here calls Stripe.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  requireTotpStepUp: vi.fn(),
  findUniqueProduct: vi.fn(),
  findUniqueOperator: vi.fn(),
  updateDraftPricing: vi.fn(),
}));

vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...args: unknown[]) => mockState.authenticateAdminRequest(...args),
}));

vi.mock('@/lib/operator-totp-stepup', () => ({
  requireTotpStepUp: (...args: unknown[]) => mockState.requireTotpStepUp(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    product: { findUnique: (...args: unknown[]) => mockState.findUniqueProduct(...args) },
    operator: { findUnique: (...args: unknown[]) => mockState.findUniqueOperator(...args) },
  },
  isDatabaseConfigured: true,
}));

vi.mock('@/lib/stripe-catalog', () => ({
  updateDraftPricing: (...args: unknown[]) => mockState.updateDraftPricing(...args),
}));

const AUTH_OK = { ok: true, sessionId: 's1', operatorId: 'op_1' };
const STEP_UP_OK = { ok: true, operatorId: 'op_1', sessionId: 's1' };
const VALID_BODY = {
  priceCents: 15900,
  setupFeeCents: 29000,
  expectedPriceCents: 14900,
  expectedSetupFeeCents: 29000,
};

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

async function callRoute(body: unknown) {
  const { POST } = await import('@/app/api/admin/portal/settings/products/[productId]/draft-price/route');
  return POST(makeRequest(body), { params: { productId: 'prod_1' } });
}

beforeEach(() => {
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue(AUTH_OK);
  mockState.requireTotpStepUp.mockReset().mockResolvedValue(STEP_UP_OK);
  mockState.findUniqueProduct.mockReset().mockResolvedValue({ id: 'prod_1' });
  mockState.findUniqueOperator.mockReset().mockResolvedValue({ email: 'lucia@kairikos.com' });
  mockState.updateDraftPricing.mockReset();
});

describe('POST /api/admin/portal/settings/products/[productId]/draft-price', () => {
  it('401s without a real operator session', async () => {
    mockState.authenticateAdminRequest.mockResolvedValueOnce({ ok: false });
    const res = await callRoute(VALID_BODY);
    expect(res.status).toBe(401);
    expect(mockState.updateDraftPricing).not.toHaveBeenCalled();
  });

  it('403s without a fresh TOTP step-up — setting a launch price is still a real pricing decision', async () => {
    mockState.requireTotpStepUp.mockResolvedValueOnce({ ok: false, status: 403, error: 'totp_step_up_required' });
    const res = await callRoute(VALID_BODY);
    expect(res.status).toBe(403);
    expect(mockState.updateDraftPricing).not.toHaveBeenCalled();
  });

  it('400s an invalid body (negative price)', async () => {
    const res = await callRoute({ ...VALID_BODY, priceCents: -100 });
    expect(res.status).toBe(400);
    expect(mockState.updateDraftPricing).not.toHaveBeenCalled();
  });

  it('404s when the product does not exist', async () => {
    mockState.findUniqueProduct.mockResolvedValueOnce(null);
    const res = await callRoute(VALID_BODY);
    expect(res.status).toBe(404);
  });

  it('409s already_bootstrapped — someone ran Bootstrap in the meantime, reprice is the only valid path now', async () => {
    mockState.updateDraftPricing.mockResolvedValueOnce({ ok: false, error: { kind: 'already_bootstrapped' } });
    const res = await callRoute(VALID_BODY);
    expect(res.status).toBe(409);
    expect(await res.clone().json()).toEqual({ error: 'already_bootstrapped' });
  });

  it('409s concurrent_modification', async () => {
    mockState.updateDraftPricing.mockResolvedValueOnce({ ok: false, error: { kind: 'concurrent_modification' } });
    const res = await callRoute(VALID_BODY);
    expect(res.status).toBe(409);
  });

  it('200s on success and passes the actor through to updateDraftPricing', async () => {
    mockState.updateDraftPricing.mockResolvedValueOnce({ ok: true, product: { id: 'prod_1', priceCents: 15900 } });
    const res = await callRoute(VALID_BODY);
    expect(res.status).toBe(200);
    expect(mockState.updateDraftPricing).toHaveBeenCalledWith(
      expect.objectContaining({ productId: 'prod_1', newPriceCents: 15900, newSetupFeeCents: 29000 }),
      { operatorId: 'op_1', operatorEmail: 'lucia@kairikos.com' },
    );
  });

  it('never calls isStripeConfigured — this must work with no Stripe key saved at all', async () => {
    // A pre-bootstrap price is just a number on the Product row; there is
    // nothing on Stripe yet for a missing credential to block.
    mockState.updateDraftPricing.mockResolvedValueOnce({ ok: true, product: { id: 'prod_1', priceCents: 15900 } });
    const mod = await import('@/lib/stripe');
    const spy = vi.spyOn(mod, 'isStripeConfigured');
    await callRoute(VALID_BODY);
    expect(spy).not.toHaveBeenCalled();
  });

  it('500s cleanly, rather than crashing, when updateDraftPricing throws', async () => {
    mockState.updateDraftPricing.mockRejectedValueOnce(new Error('db blip'));
    const res = await callRoute(VALID_BODY);
    expect(res.status).toBe(500);
    expect(await res.clone().json()).toEqual({ error: 'internal_error' });
  });
});
