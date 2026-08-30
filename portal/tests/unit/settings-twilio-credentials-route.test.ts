// =============================================================================
// Unit tests for POST/GET /api/admin/portal/settings/twilio/credentials.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  requireTotpStepUp: vi.fn(),
  findUniqueOperator: vi.fn(),
  getTwilioCredentialStatus: vi.fn(),
  saveTwilioCredential: vi.fn(),
  fetch: vi.fn(),
}));

vi.stubGlobal('fetch', mockState.fetch);

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

vi.mock('@/lib/twilio-credentials', () => ({
  getTwilioCredentialStatus: (...args: unknown[]) => mockState.getTwilioCredentialStatus(...args),
  saveTwilioCredential: (...args: unknown[]) => mockState.saveTwilioCredential(...args),
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
  mockState.getTwilioCredentialStatus.mockReset();
  mockState.saveTwilioCredential.mockReset().mockResolvedValue(undefined);
  mockState.fetch.mockReset().mockResolvedValue({ ok: true, json: async () => ({}) });
});

describe('GET /api/admin/portal/settings/twilio/credentials', () => {
  it('401s without a session', async () => {
    mockState.authenticateAdminRequest.mockResolvedValueOnce({ ok: false });
    const { GET } = await import('@/app/api/admin/portal/settings/twilio/credentials/route');
    const res = await GET({} as NextRequest);
    expect(res.status).toBe(401);
  });

  it('returns the masked status', async () => {
    const status = { configured: true, accountSid: 'AC1234', authTokenLastFour: 'abCD', savedAt: '2026-01-01T00:00:00.000Z' };
    mockState.getTwilioCredentialStatus.mockResolvedValueOnce(status);
    const { GET } = await import('@/app/api/admin/portal/settings/twilio/credentials/route');
    const res = await GET({} as NextRequest);
    expect(res.status).toBe(200);
    expect(await res.clone().json()).toEqual(status);
  });
});

describe('POST /api/admin/portal/settings/twilio/credentials', () => {
  // Deliberately NOT a real-shaped Twilio SID (AC + 32 hex chars) — a
  // fixture that matched the pattern tripped GitHub's push-protection
  // secret scanner on this file.
  const VALID_BODY = { accountSid: 'ACfaketestsidnotreal', authToken: 'authtoken_abcdWXYZ' };

  it('403s without TOTP step-up (does not even reach Twilio or the DB)', async () => {
    mockState.requireTotpStepUp.mockResolvedValueOnce({ ok: false, status: 403, error: 'totp_step_up_required' });
    const { POST } = await import('@/app/api/admin/portal/settings/twilio/credentials/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(403);
    expect(mockState.fetch).not.toHaveBeenCalled();
    expect(mockState.saveTwilioCredential).not.toHaveBeenCalled();
  });

  it('400s when the Account SID does not start with AC', async () => {
    const { POST } = await import('@/app/api/admin/portal/settings/twilio/credentials/route');
    const res = await POST(makeRequest({ accountSid: 'wrongPrefix', authToken: 'tok' }));
    expect(res.status).toBe(400);
    const body = await res.clone().json();
    expect(body.error).toBe('invalid_twilio_credentials');
    expect(mockState.saveTwilioCredential).not.toHaveBeenCalled();
  });

  it('400s when Twilio rejects the credentials', async () => {
    mockState.fetch.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    const { POST } = await import('@/app/api/admin/portal/settings/twilio/credentials/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(400);
    expect(mockState.saveTwilioCredential).not.toHaveBeenCalled();
  });

  it('400s when the verification call itself throws (network failure)', async () => {
    mockState.fetch.mockRejectedValueOnce(new Error('network down'));
    const { POST } = await import('@/app/api/admin/portal/settings/twilio/credentials/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(400);
    expect(mockState.saveTwilioCredential).not.toHaveBeenCalled();
  });

  it('verifies against the correct Twilio endpoint with Basic Auth before saving', async () => {
    const { POST } = await import('@/app/api/admin/portal/settings/twilio/credentials/route');
    await POST(makeRequest(VALID_BODY));

    const [url, init] = mockState.fetch.mock.calls[0];
    expect(String(url)).toBe(`https://api.twilio.com/2010-04-01/Accounts/${VALID_BODY.accountSid}.json`);
    const expectedAuth = `Basic ${Buffer.from(`${VALID_BODY.accountSid}:${VALID_BODY.authToken}`).toString('base64')}`;
    expect(init.headers.Authorization).toBe(expectedAuth);
  });

  it('saves the credential on the happy path and never echoes the token back', async () => {
    const { POST } = await import('@/app/api/admin/portal/settings/twilio/credentials/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(200);
    const body = await res.clone().json();
    expect(body).toEqual({ ok: true, accountSid: VALID_BODY.accountSid, lastFour: 'WXYZ' });
    expect(mockState.saveTwilioCredential).toHaveBeenCalledWith(
      VALID_BODY.accountSid,
      VALID_BODY.authToken,
      { operatorId: 'op_1', operatorEmail: 'lucia@kairikos.com' },
    );
    expect(JSON.stringify(body)).not.toContain(VALID_BODY.authToken);
  });

  it('500s cleanly, rather than crashing, when persisting the credential throws', async () => {
    mockState.saveTwilioCredential.mockRejectedValueOnce(new Error('TWILIO_CREDENTIAL_ENCRYPTION_KEY is not set'));
    const { POST } = await import('@/app/api/admin/portal/settings/twilio/credentials/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(500);
    const body = await res.clone().json();
    expect(body).toEqual({ error: 'internal_error' });
    expect(JSON.stringify(body)).not.toContain(VALID_BODY.authToken);
  });
});
