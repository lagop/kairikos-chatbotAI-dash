// =============================================================================
// Fase 6 — unit tests for POST /api/admin/portal/recall/contract/sign.
//
// The state-machine logic itself is covered in recall-onboarding.test.ts;
// this file covers the HTTP layer — auth, validation, status-code
// mapping, and the legacy-auth → null operatorId guard.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  isDatabaseConfigured: true,
  markContractSigned: vi.fn(),
}));

vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...a: unknown[]) => mockState.authenticateAdminRequest(...a),
}));

vi.mock('@/lib/recall-onboarding', () => ({
  markContractSigned: (...a: unknown[]) => mockState.markContractSigned(...a),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {},
}));

const AUTH_OK = { ok: true, sessionId: 's1', operatorId: 'op_1' };
const SUBSCRIPTION_ID = '11111111-1111-1111-1111-111111111111';

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue(AUTH_OK);
  mockState.isDatabaseConfigured = true;
  mockState.markContractSigned.mockReset().mockResolvedValue({ ok: true });
});

describe('POST /api/admin/portal/recall/contract/sign', () => {
  it('401s without a valid admin session', async () => {
    mockState.authenticateAdminRequest.mockResolvedValueOnce({ ok: false });
    const { POST } = await import('@/app/api/admin/portal/recall/contract/sign/route');
    const res = await POST(makeRequest({ subscriptionId: SUBSCRIPTION_ID }));
    expect(res.status).toBe(401);
    expect(mockState.markContractSigned).not.toHaveBeenCalled();
  });

  it('503s when the database is not configured', async () => {
    mockState.isDatabaseConfigured = false;
    const { POST } = await import('@/app/api/admin/portal/recall/contract/sign/route');
    const res = await POST(makeRequest({ subscriptionId: SUBSCRIPTION_ID }));
    expect(res.status).toBe(503);
  });

  it('400s when subscriptionId is missing or not a UUID', async () => {
    const { POST } = await import('@/app/api/admin/portal/recall/contract/sign/route');
    const res1 = await POST(makeRequest({}));
    expect(res1.status).toBe(400);
    const res2 = await POST(makeRequest({ subscriptionId: 'not-a-uuid' }));
    expect(res2.status).toBe(400);
    expect(mockState.markContractSigned).not.toHaveBeenCalled();
  });

  it('404s when the subscription does not exist', async () => {
    mockState.markContractSigned.mockResolvedValueOnce({ ok: false, error: 'subscription_not_found' });
    const { POST } = await import('@/app/api/admin/portal/recall/contract/sign/route');
    const res = await POST(makeRequest({ subscriptionId: SUBSCRIPTION_ID }));
    expect(res.status).toBe(404);
  });

  it('409s when the subscription is not in paid (already signed, or cancelled)', async () => {
    mockState.markContractSigned.mockResolvedValueOnce({ ok: false, error: 'invalid_status' });
    const { POST } = await import('@/app/api/admin/portal/recall/contract/sign/route');
    const res = await POST(makeRequest({ subscriptionId: SUBSCRIPTION_ID }));
    expect(res.status).toBe(409);
  });

  it('signs successfully and passes the real operatorId through', async () => {
    const { POST } = await import('@/app/api/admin/portal/recall/contract/sign/route');
    const res = await POST(makeRequest({ subscriptionId: SUBSCRIPTION_ID }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, subscriptionId: SUBSCRIPTION_ID, status: 'contract_signed' });
    expect(mockState.markContractSigned).toHaveBeenCalledWith(
      expect.anything(),
      SUBSCRIPTION_ID,
      { operatorId: 'op_1' },
    );
  });

  it("resolves the legacy KAIA_OPERATOR_API_KEY auth to a null operatorId, never the literal string 'legacy'", async () => {
    mockState.authenticateAdminRequest.mockResolvedValueOnce({ ok: true, sessionId: 'legacy', operatorId: 'legacy' });
    const { POST } = await import('@/app/api/admin/portal/recall/contract/sign/route');
    await POST(makeRequest({ subscriptionId: SUBSCRIPTION_ID }));
    expect(mockState.markContractSigned).toHaveBeenCalledWith(expect.anything(), SUBSCRIPTION_ID, { operatorId: null });
  });
});
