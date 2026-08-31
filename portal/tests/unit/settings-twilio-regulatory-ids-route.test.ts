// =============================================================================
// Unit tests for POST /api/admin/portal/settings/twilio/regulatory-ids.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  findUniqueOperator: vi.fn(),
  saveTwilioRegulatoryIds: vi.fn(),
}));

vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...args: unknown[]) => mockState.authenticateAdminRequest(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    operator: { findUnique: (...args: unknown[]) => mockState.findUniqueOperator(...args) },
  },
  isDatabaseConfigured: true,
}));

vi.mock('@/lib/twilio-credentials', () => ({
  saveTwilioRegulatoryIds: (...args: unknown[]) => mockState.saveTwilioRegulatoryIds(...args),
}));

const AUTH_OK = { ok: true, sessionId: 's1', operatorId: 'op_1' };
const AUTH_LEGACY = { ok: true, sessionId: 'legacy', operatorId: 'legacy' };

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue(AUTH_OK);
  mockState.findUniqueOperator.mockReset().mockResolvedValue({ email: 'lucia@kairikos.com' });
  mockState.saveTwilioRegulatoryIds.mockReset().mockResolvedValue(undefined);
});

const VALID_BODY = { bundleSid: 'BUfaketestbundle', addressSid: 'ADfaketestaddress' };

describe('POST /api/admin/portal/settings/twilio/regulatory-ids', () => {
  it('401s without a session', async () => {
    mockState.authenticateAdminRequest.mockResolvedValueOnce({ ok: false });
    const { POST } = await import('@/app/api/admin/portal/settings/twilio/regulatory-ids/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(401);
    expect(mockState.saveTwilioRegulatoryIds).not.toHaveBeenCalled();
  });

  it('400s when either field is missing', async () => {
    const { POST } = await import('@/app/api/admin/portal/settings/twilio/regulatory-ids/route');
    const res = await POST(makeRequest({ bundleSid: 'BU1' }));
    expect(res.status).toBe(400);
    expect(mockState.saveTwilioRegulatoryIds).not.toHaveBeenCalled();
  });

  it('never requires TOTP step-up — accepts a plain admin session', async () => {
    const { POST } = await import('@/app/api/admin/portal/settings/twilio/regulatory-ids/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(200);
  });

  it('saves on the happy path', async () => {
    const { POST } = await import('@/app/api/admin/portal/settings/twilio/regulatory-ids/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(200);
    const body = await res.clone().json();
    expect(body).toEqual({ ok: true, bundleSid: VALID_BODY.bundleSid, addressSid: VALID_BODY.addressSid });
    expect(mockState.saveTwilioRegulatoryIds).toHaveBeenCalledWith(
      VALID_BODY.bundleSid,
      VALID_BODY.addressSid,
      { operatorId: 'op_1', operatorEmail: 'lucia@kairikos.com' },
    );
  });

  it('passes operatorId: null for the legacy key path instead of the non-UUID "legacy" sentinel', async () => {
    mockState.authenticateAdminRequest.mockResolvedValueOnce(AUTH_LEGACY);
    const { POST } = await import('@/app/api/admin/portal/settings/twilio/regulatory-ids/route');
    await POST(makeRequest(VALID_BODY));

    expect(mockState.findUniqueOperator).not.toHaveBeenCalled();
    expect(mockState.saveTwilioRegulatoryIds).toHaveBeenCalledWith(
      VALID_BODY.bundleSid,
      VALID_BODY.addressSid,
      { operatorId: null, operatorEmail: null },
    );
  });

  it('500s cleanly, rather than crashing, when persisting throws', async () => {
    mockState.saveTwilioRegulatoryIds.mockRejectedValueOnce(new Error('db down'));
    const { POST } = await import('@/app/api/admin/portal/settings/twilio/regulatory-ids/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(500);
    expect(await res.clone().json()).toEqual({ error: 'internal_error' });
  });
});
