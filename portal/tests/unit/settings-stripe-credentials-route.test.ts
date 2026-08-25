// =============================================================================
// Unit tests for POST/GET /api/admin/portal/settings/stripe/credentials.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  requireTotpStepUp: vi.fn(),
  findUniqueOperator: vi.fn(),
  getStripeCredentialStatus: vi.fn(),
  saveStripeCredential: vi.fn(),
  balanceRetrieve: vi.fn(),
}));

vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...args: unknown[]) => mockState.authenticateAdminRequest(...args),
}));

vi.mock('@/lib/operator-totp-stepup', () => ({
  requireTotpStepUp: (...args: unknown[]) => mockState.requireTotpStepUp(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    operator: { findUnique: (...args: unknown[]) => mockState.findUniqueOperator(...args) },
  },
  isDatabaseConfigured: true,
}));

vi.mock('@/lib/stripe', () => ({
  getStripeApiVersion: () => '2024-06-20',
}));

vi.mock('@/lib/stripe-credentials', () => ({
  getStripeCredentialStatus: (...args: unknown[]) => mockState.getStripeCredentialStatus(...args),
  saveStripeCredential: (...args: unknown[]) => mockState.saveStripeCredential(...args),
}));

vi.mock('stripe', () => ({
  default: class MockStripe {
    balance = { retrieve: (...args: unknown[]) => mockState.balanceRetrieve(...args) };
  },
}));

const AUTH_OK = { ok: true, sessionId: 's1', operatorId: 'op_1' };
const STEP_UP_OK = { ok: true, operatorId: 'op_1', sessionId: 's1' };

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue(AUTH_OK);
  mockState.requireTotpStepUp.mockReset().mockResolvedValue(STEP_UP_OK);
  mockState.findUniqueOperator.mockReset().mockResolvedValue({ email: 'lucia@kairikos.com' });
  mockState.getStripeCredentialStatus.mockReset();
  mockState.saveStripeCredential.mockReset().mockResolvedValue(undefined);
  mockState.balanceRetrieve.mockReset().mockResolvedValue({ available: [] });
});

describe('GET /api/admin/portal/settings/stripe/credentials', () => {
  it('401s without a session', async () => {
    mockState.authenticateAdminRequest.mockResolvedValueOnce({ ok: false });
    const { GET } = await import('@/app/api/admin/portal/settings/stripe/credentials/route');
    const res = await GET({} as NextRequest);
    expect(res.status).toBe(401);
  });

  it('returns the masked status', async () => {
    const status = {
      activeMode: 'test',
      test: { configured: true, lastFour: 'abCD', savedAt: '2026-01-01T00:00:00.000Z' },
      live: { configured: false, lastFour: null, savedAt: null },
    };
    mockState.getStripeCredentialStatus.mockResolvedValueOnce(status);
    const { GET } = await import('@/app/api/admin/portal/settings/stripe/credentials/route');
    const res = await GET({} as NextRequest);
    expect(res.status).toBe(200);
    expect(await res.clone().json()).toEqual(status);
  });
});

describe('POST /api/admin/portal/settings/stripe/credentials', () => {
  const VALID_BODY = { mode: 'test', secretKey: 'sk_test_abcd1234WXYZ' };

  it('403s without TOTP step-up (does not even reach Stripe or the DB)', async () => {
    mockState.requireTotpStepUp.mockResolvedValueOnce({ ok: false, status: 403, error: 'totp_step_up_required' });
    const { POST } = await import('@/app/api/admin/portal/settings/stripe/credentials/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(403);
    expect(mockState.balanceRetrieve).not.toHaveBeenCalled();
    expect(mockState.saveStripeCredential).not.toHaveBeenCalled();
  });

  it('400s when the key prefix does not match the declared mode', async () => {
    const { POST } = await import('@/app/api/admin/portal/settings/stripe/credentials/route');
    const res = await POST(makeRequest({ mode: 'live', secretKey: 'sk_test_wrongPrefix' }));
    expect(res.status).toBe(400);
    const body = await res.clone().json();
    expect(body.error).toBe('invalid_stripe_key');
    expect(mockState.saveStripeCredential).not.toHaveBeenCalled();
  });

  it('400s when Stripe rejects the key (balance.retrieve throws)', async () => {
    mockState.balanceRetrieve.mockRejectedValueOnce(new Error('Invalid API Key provided'));
    const { POST } = await import('@/app/api/admin/portal/settings/stripe/credentials/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(400);
    expect(mockState.saveStripeCredential).not.toHaveBeenCalled();
  });

  it('saves the credential on the happy path and never echoes the key back', async () => {
    const { POST } = await import('@/app/api/admin/portal/settings/stripe/credentials/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(200);
    const body = await res.clone().json();
    expect(body).toEqual({ ok: true, mode: 'test', lastFour: 'WXYZ' });
    expect(mockState.saveStripeCredential).toHaveBeenCalledWith(
      'test',
      'sk_test_abcd1234WXYZ',
      { operatorId: 'op_1', operatorEmail: 'lucia@kairikos.com' },
    );
    // The response body itself must never contain the full plaintext key.
    expect(JSON.stringify(body)).not.toContain('sk_test_abcd1234WXYZ');
  });

  it('500s cleanly, rather than crashing, when persisting the key throws', async () => {
    // Regression: a misconfigured STRIPE_CREDENTIAL_ENCRYPTION_KEY (unset
    // or the wrong length — see operator-crypto.ts's parseHexKey) threw
    // synchronously inside saveStripeCredential, unguarded. The route
    // crashed as an unhandled exception instead of returning JSON, the
    // panel's safeJson() fell back to {}, and the operator saw the
    // generic 'No se pudo completar la operación' with nothing pointing
    // at the real cause.
    mockState.saveStripeCredential.mockRejectedValueOnce(
      new Error('STRIPE_CREDENTIAL_ENCRYPTION_KEY is not set'),
    );
    const { POST } = await import('@/app/api/admin/portal/settings/stripe/credentials/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(500);
    const body = await res.clone().json();
    expect(body).toEqual({ error: 'internal_error' });
    // Still never echoes the key back, even on the failure path.
    expect(JSON.stringify(body)).not.toContain('sk_test_abcd1234WXYZ');
  });
});
