// =============================================================================
// Unit tests for POST/GET /api/admin/portal/settings/anthropic/credentials.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  requireTotpStepUp: vi.fn(),
  findUniqueOperator: vi.fn(),
  getAnthropicCredentialStatus: vi.fn(),
  saveAnthropicCredential: vi.fn(),
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

vi.mock('@/lib/anthropic-credentials', () => ({
  getAnthropicCredentialStatus: (...args: unknown[]) => mockState.getAnthropicCredentialStatus(...args),
  saveAnthropicCredential: (...args: unknown[]) => mockState.saveAnthropicCredential(...args),
  DEFAULT_BASE_URL: 'https://api.anthropic.com',
  DEFAULT_MODEL: 'claude-haiku-4-5-20251001',
}));

const AUTH_OK = { ok: true, sessionId: 's1', operatorId: 'op_1' };
const STEP_UP_OK = { ok: true, operatorId: 'op_1', sessionId: 's1' };

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

function messagesResponse(ok: boolean) {
  return { ok, json: async () => ({ content: [{ type: 'text', text: 'hola' }] }) };
}

beforeEach(() => {
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue(AUTH_OK);
  mockState.requireTotpStepUp.mockReset().mockResolvedValue(STEP_UP_OK);
  mockState.findUniqueOperator.mockReset().mockResolvedValue({ email: 'lucia@kairikos.com' });
  mockState.getAnthropicCredentialStatus.mockReset();
  mockState.saveAnthropicCredential.mockReset().mockResolvedValue(undefined);
  mockState.fetch.mockReset().mockResolvedValue(messagesResponse(true));
});

describe('GET /api/admin/portal/settings/anthropic/credentials', () => {
  it('401s without a session', async () => {
    mockState.authenticateAdminRequest.mockResolvedValueOnce({ ok: false });
    const { GET } = await import('@/app/api/admin/portal/settings/anthropic/credentials/route');
    const res = await GET({} as NextRequest);
    expect(res.status).toBe(401);
  });

  it('returns the masked status', async () => {
    const status = { configured: true, apiKeyLastFour: 'abCD', savedAt: '2026-01-01T00:00:00.000Z', baseUrl: null, model: null };
    mockState.getAnthropicCredentialStatus.mockResolvedValueOnce(status);
    const { GET } = await import('@/app/api/admin/portal/settings/anthropic/credentials/route');
    const res = await GET({} as NextRequest);
    expect(res.status).toBe(200);
    expect(await res.clone().json()).toEqual(status);
  });
});

describe('POST /api/admin/portal/settings/anthropic/credentials', () => {
  const VALID_BODY = { apiKey: 'sk-ant-fake-test-key-WXYZ' };

  it('403s without TOTP step-up (does not even reach Anthropic or the DB)', async () => {
    mockState.requireTotpStepUp.mockResolvedValueOnce({ ok: false, status: 403, error: 'totp_step_up_required' });
    const { POST } = await import('@/app/api/admin/portal/settings/anthropic/credentials/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(403);
    expect(mockState.fetch).not.toHaveBeenCalled();
    expect(mockState.saveAnthropicCredential).not.toHaveBeenCalled();
  });

  it('400s on an invalid body (missing apiKey)', async () => {
    const { POST } = await import('@/app/api/admin/portal/settings/anthropic/credentials/route');
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    const body = await res.clone().json();
    expect(body.error).toBe('invalid_body');
    expect(mockState.saveAnthropicCredential).not.toHaveBeenCalled();
  });

  it('400s when baseUrl is not a valid URL', async () => {
    const { POST } = await import('@/app/api/admin/portal/settings/anthropic/credentials/route');
    const res = await POST(makeRequest({ ...VALID_BODY, baseUrl: 'not-a-url' }));
    expect(res.status).toBe(400);
    const body = await res.clone().json();
    expect(body.error).toBe('invalid_base_url');
    expect(mockState.fetch).not.toHaveBeenCalled();
    expect(mockState.saveAnthropicCredential).not.toHaveBeenCalled();
  });

  it('400s when Anthropic rejects the credentials', async () => {
    mockState.fetch.mockResolvedValueOnce(messagesResponse(false));
    const { POST } = await import('@/app/api/admin/portal/settings/anthropic/credentials/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(400);
    const body = await res.clone().json();
    expect(body.error).toBe('invalid_anthropic_credentials');
    expect(mockState.saveAnthropicCredential).not.toHaveBeenCalled();
  });

  it('400s when the verification call itself throws (network failure)', async () => {
    mockState.fetch.mockRejectedValueOnce(new Error('network down'));
    const { POST } = await import('@/app/api/admin/portal/settings/anthropic/credentials/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(400);
    expect(mockState.saveAnthropicCredential).not.toHaveBeenCalled();
  });

  it('verifies against the default endpoint/model with a 1-token completion when none were entered', async () => {
    const { POST } = await import('@/app/api/admin/portal/settings/anthropic/credentials/route');
    await POST(makeRequest(VALID_BODY));

    const [url, init] = mockState.fetch.mock.calls[0];
    expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe(VALID_BODY.apiKey);
    const sentBody = JSON.parse(init.body);
    expect(sentBody.model).toBe('claude-haiku-4-5-20251001');
    expect(sentBody.max_tokens).toBe(1);
  });

  it('verifies against a custom baseUrl/model when both are entered', async () => {
    const { POST } = await import('@/app/api/admin/portal/settings/anthropic/credentials/route');
    await POST(makeRequest({ apiKey: VALID_BODY.apiKey, baseUrl: 'https://proxy.example.com', model: 'claude-opus-5' }));

    const [url, init] = mockState.fetch.mock.calls[0];
    expect(String(url)).toBe('https://proxy.example.com/v1/messages');
    const sentBody = JSON.parse(init.body);
    expect(sentBody.model).toBe('claude-opus-5');
  });

  it('saves the credential on the happy path and never echoes the key back', async () => {
    const { POST } = await import('@/app/api/admin/portal/settings/anthropic/credentials/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(200);
    const body = await res.clone().json();
    expect(body).toEqual({ ok: true, lastFour: 'WXYZ', baseUrl: null, model: null });
    expect(mockState.saveAnthropicCredential).toHaveBeenCalledWith(
      { apiKey: VALID_BODY.apiKey, baseUrl: null, model: null },
      { operatorId: 'op_1', operatorEmail: 'lucia@kairikos.com' },
    );
    expect(JSON.stringify(body)).not.toContain(VALID_BODY.apiKey);
  });

  it('500s cleanly, rather than crashing, when persisting the credential throws', async () => {
    mockState.saveAnthropicCredential.mockRejectedValueOnce(new Error('ANTHROPIC_CREDENTIAL_ENCRYPTION_KEY is not set'));
    const { POST } = await import('@/app/api/admin/portal/settings/anthropic/credentials/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(500);
    const body = await res.clone().json();
    expect(body).toEqual({ error: 'internal_error' });
    expect(JSON.stringify(body)).not.toContain(VALID_BODY.apiKey);
  });
});
