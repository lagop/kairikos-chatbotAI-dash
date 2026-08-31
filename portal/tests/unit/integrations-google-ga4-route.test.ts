// =============================================================================
// Unit tests for /api/admin/portal/settings/integrations/google-ga4.
// Mirrors integrations-google-business-route.test.ts's conventions exactly
// — same shape, different toolKey/displayName/route.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  authenticateAdminRequest: vi.fn(),
  operatorFindUnique: vi.fn(),
  getIntegrationCredentialStatus: vi.fn(),
  saveIntegrationCredential: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    operator: { findUnique: (...a: unknown[]) => mockState.operatorFindUnique(...a) },
  },
}));

vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...a: unknown[]) => mockState.authenticateAdminRequest(...a),
}));

vi.mock('@/lib/integration-credentials', () => ({
  getIntegrationCredentialStatus: (...a: unknown[]) => mockState.getIntegrationCredentialStatus(...a),
  saveIntegrationCredential: (...a: unknown[]) => mockState.saveIntegrationCredential(...a),
}));

vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

import { GET, POST } from '@/app/api/admin/portal/settings/integrations/google-ga4/route';

function makeRequest(body?: unknown) {
  return { json: async () => body ?? null } as unknown as NextRequest;
}

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue({ ok: true, sessionId: 's1', operatorId: 'op_1' });
  mockState.operatorFindUnique.mockReset().mockResolvedValue({ email: 'op@kairikos.com' });
  mockState.getIntegrationCredentialStatus
    .mockReset()
    .mockResolvedValue({ configured: false, lastFour: null, savedAt: null, clientId: null });
  mockState.saveIntegrationCredential.mockReset().mockResolvedValue(undefined);
  mockState.logError.mockReset();
});

describe('GET /api/admin/portal/settings/integrations/google-ga4', () => {
  it('401s without a valid admin session', async () => {
    mockState.authenticateAdminRequest.mockResolvedValue({ ok: false });
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns the masked credential status, including the cleartext clientId', async () => {
    mockState.getIntegrationCredentialStatus.mockResolvedValue({
      configured: true,
      lastFour: 'aBcD',
      savedAt: '2026-09-06T00:00:00.000Z',
      clientId: '789-ghi.apps.googleusercontent.com',
    });
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.clientId).toBe('789-ghi.apps.googleusercontent.com');
    expect(mockState.getIntegrationCredentialStatus).toHaveBeenCalledWith('google_ga4');
  });

  it('503s when the database is not configured', async () => {
    mockState.isDatabaseConfigured = false;
    const res = await GET(makeRequest());
    expect(res.status).toBe(503);
  });
});

describe('POST /api/admin/portal/settings/integrations/google-ga4', () => {
  const VALID_BODY = { clientId: '789-ghi.apps.googleusercontent.com', clientSecret: 'gocspx-real-looking-secret' };

  it('401s without a valid admin session', async () => {
    mockState.authenticateAdminRequest.mockResolvedValue({ ok: false });
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(401);
    expect(mockState.saveIntegrationCredential).not.toHaveBeenCalled();
  });

  it('400s when clientId is too short', async () => {
    const res = await POST(makeRequest({ ...VALID_BODY, clientId: 'short' }));
    expect(res.status).toBe(400);
  });

  it('400s when clientSecret is too short', async () => {
    const res = await POST(makeRequest({ ...VALID_BODY, clientSecret: 'short' }));
    expect(res.status).toBe(400);
  });

  it('saves under toolKey "google_ga4" with the resolved operator email', async () => {
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(200);
    expect(mockState.saveIntegrationCredential).toHaveBeenCalledWith(
      'google_ga4',
      'Google Analytics (GA4, SEO)',
      VALID_BODY.clientSecret,
      { operatorId: 'op_1', operatorEmail: 'op@kairikos.com' },
      VALID_BODY.clientId,
    );
  });

  it('the legacy KAIA_OPERATOR_API_KEY auth path saves with a null operatorId instead of crashing on a non-UUID lookup', async () => {
    mockState.authenticateAdminRequest.mockResolvedValue({ ok: true, sessionId: 'legacy', operatorId: 'legacy' });
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(200);
    expect(mockState.operatorFindUnique).not.toHaveBeenCalled();
    expect(mockState.saveIntegrationCredential).toHaveBeenCalledWith(
      'google_ga4',
      'Google Analytics (GA4, SEO)',
      VALID_BODY.clientSecret,
      { operatorId: null, operatorEmail: null },
      VALID_BODY.clientId,
    );
  });

  it('503s when the database is not configured', async () => {
    mockState.isDatabaseConfigured = false;
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(503);
  });

  it('500s cleanly and logs when saving throws — never leaks the secret in the error', async () => {
    mockState.saveIntegrationCredential.mockRejectedValue(new Error('db down'));
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(500);
    expect(JSON.stringify(mockState.logError.mock.calls)).not.toContain(VALID_BODY.clientSecret);
  });
});
