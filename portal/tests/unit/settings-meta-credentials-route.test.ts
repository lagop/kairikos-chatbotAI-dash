// =============================================================================
// Unit tests for POST/GET /api/admin/portal/settings/meta/credentials.
// Mirrors settings-twilio-credentials-route.test.ts's conventions closely.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  requireTotpStepUp: vi.fn(),
  findUniqueOperator: vi.fn(),
  getMetaCredentialStatus: vi.fn(),
  saveMetaCredential: vi.fn(),
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

vi.mock('@/lib/meta-credentials', () => ({
  getMetaCredentialStatus: (...args: unknown[]) => mockState.getMetaCredentialStatus(...args),
  saveMetaCredential: (...args: unknown[]) => mockState.saveMetaCredential(...args),
}));

vi.mock('@/lib/meta-business', () => ({
  graphUrl: (path: string) => `https://graph.facebook.com/v21.0${path}`,
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
  mockState.getMetaCredentialStatus.mockReset();
  mockState.saveMetaCredential.mockReset().mockResolvedValue(undefined);
  mockState.fetch.mockReset().mockResolvedValue({ ok: true, json: async () => ({}) });
});

describe('GET /api/admin/portal/settings/meta/credentials', () => {
  it('401s without a session', async () => {
    mockState.authenticateAdminRequest.mockResolvedValueOnce({ ok: false });
    const { GET } = await import('@/app/api/admin/portal/settings/meta/credentials/route');
    const res = await GET({} as NextRequest);
    expect(res.status).toBe(401);
  });

  it('returns the masked status', async () => {
    const status = {
      configured: true,
      appId: 'app_1234',
      appSecretLastFour: 'abCD',
      savedAt: '2026-01-01T00:00:00.000Z',
      configId: 'config_1',
      coexistenceConfigId: null,
    };
    mockState.getMetaCredentialStatus.mockResolvedValueOnce(status);
    const { GET } = await import('@/app/api/admin/portal/settings/meta/credentials/route');
    const res = await GET({} as NextRequest);
    expect(res.status).toBe(200);
    expect(await res.clone().json()).toEqual(status);
  });
});

describe('POST /api/admin/portal/settings/meta/credentials', () => {
  const VALID_BODY = { appId: 'app_1234567890', appSecret: 'appsecret_abcdWXYZ' };

  it('403s without TOTP step-up (does not even reach Meta or the DB)', async () => {
    mockState.requireTotpStepUp.mockResolvedValueOnce({ ok: false, status: 403, error: 'totp_step_up_required' });
    const { POST } = await import('@/app/api/admin/portal/settings/meta/credentials/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(403);
    expect(mockState.fetch).not.toHaveBeenCalled();
    expect(mockState.saveMetaCredential).not.toHaveBeenCalled();
  });

  it('400s when Meta rejects the credentials', async () => {
    mockState.fetch.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    const { POST } = await import('@/app/api/admin/portal/settings/meta/credentials/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(400);
    const body = await res.clone().json();
    expect(body.error).toBe('invalid_meta_credentials');
    expect(mockState.saveMetaCredential).not.toHaveBeenCalled();
  });

  it('400s when the verification call itself throws (network failure)', async () => {
    mockState.fetch.mockRejectedValueOnce(new Error('network down'));
    const { POST } = await import('@/app/api/admin/portal/settings/meta/credentials/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(400);
    expect(mockState.saveMetaCredential).not.toHaveBeenCalled();
  });

  it('verifies against the correct Meta endpoint before saving', async () => {
    const { POST } = await import('@/app/api/admin/portal/settings/meta/credentials/route');
    await POST(makeRequest(VALID_BODY));

    const [url] = mockState.fetch.mock.calls[0];
    expect(String(url)).toContain('https://graph.facebook.com/v21.0/oauth/access_token?');
    expect(String(url)).toContain(`client_id=${VALID_BODY.appId}`);
    expect(String(url)).toContain('grant_type=client_credentials');
  });

  it('saves the credential on the happy path and never echoes the secret back', async () => {
    const { POST } = await import('@/app/api/admin/portal/settings/meta/credentials/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(200);
    const body = await res.clone().json();
    expect(body).toEqual({ ok: true, appId: VALID_BODY.appId, lastFour: 'WXYZ' });
    expect(mockState.saveMetaCredential).toHaveBeenCalledWith(
      VALID_BODY.appId,
      VALID_BODY.appSecret,
      { operatorId: 'op_1', operatorEmail: 'lucia@kairikos.com' },
    );
    expect(JSON.stringify(body)).not.toContain(VALID_BODY.appSecret);
  });

  it('500s cleanly, rather than crashing, when persisting the credential throws', async () => {
    mockState.saveMetaCredential.mockRejectedValueOnce(new Error('META_CREDENTIAL_ENCRYPTION_KEY is not set'));
    const { POST } = await import('@/app/api/admin/portal/settings/meta/credentials/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(500);
    const body = await res.clone().json();
    expect(body).toEqual({ error: 'internal_error' });
    expect(JSON.stringify(body)).not.toContain(VALID_BODY.appSecret);
  });
});
