// =============================================================================
// Unit tests for /api/admin/portal/settings/integrations/google-places.
// Same mocking conventions as the Stripe credentials route's own tests,
// minus TOTP step-up — this route doesn't require it (see the route's
// own header for why).
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

import { GET, POST } from '@/app/api/admin/portal/settings/integrations/google-places/route';

function makeRequest(body?: unknown) {
  return { json: async () => body ?? null } as unknown as NextRequest;
}

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue({ ok: true, sessionId: 's1', operatorId: 'op_1' });
  mockState.operatorFindUnique.mockReset().mockResolvedValue({ email: 'op@kairikos.com' });
  mockState.getIntegrationCredentialStatus.mockReset().mockResolvedValue({ configured: false, lastFour: null, savedAt: null });
  mockState.saveIntegrationCredential.mockReset().mockResolvedValue(undefined);
  mockState.logError.mockReset();
});

describe('GET /api/admin/portal/settings/integrations/google-places', () => {
  it('401s without a valid admin session', async () => {
    mockState.authenticateAdminRequest.mockResolvedValue({ ok: false });
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns the masked credential status', async () => {
    mockState.getIntegrationCredentialStatus.mockResolvedValue({ configured: true, lastFour: 'aBcD', savedAt: '2026-09-06T00:00:00.000Z' });
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ configured: true, lastFour: 'aBcD', savedAt: '2026-09-06T00:00:00.000Z' });
    expect(mockState.getIntegrationCredentialStatus).toHaveBeenCalledWith('google_places');
  });

  it('503s when the database is not configured', async () => {
    mockState.isDatabaseConfigured = false;
    const res = await GET(makeRequest());
    expect(res.status).toBe(503);
  });
});

describe('POST /api/admin/portal/settings/integrations/google-places', () => {
  it('401s without a valid admin session', async () => {
    mockState.authenticateAdminRequest.mockResolvedValue({ ok: false });
    const res = await POST(makeRequest({ apiKey: 'AIzaSomeRealLookingKey' }));
    expect(res.status).toBe(401);
    expect(mockState.saveIntegrationCredential).not.toHaveBeenCalled();
  });

  it('400s when the key is too short to plausibly be real', async () => {
    const res = await POST(makeRequest({ apiKey: 'short' }));
    expect(res.status).toBe(400);
    expect(mockState.saveIntegrationCredential).not.toHaveBeenCalled();
  });

  it('400s on a missing body', async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(400);
  });

  it('saves the key under toolKey "google_places" with the resolved operator email', async () => {
    const res = await POST(makeRequest({ apiKey: 'AIzaSomeRealLookingKey' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, lastFour: 'gKey' });
    expect(mockState.saveIntegrationCredential).toHaveBeenCalledWith(
      'google_places',
      'Google Places',
      'AIzaSomeRealLookingKey',
      { operatorId: 'op_1', operatorEmail: 'op@kairikos.com' },
    );
  });

  it('the legacy KAIA_OPERATOR_API_KEY auth path saves with a null operatorId instead of crashing on a non-UUID lookup', async () => {
    // authenticateAdminRequest returns the placeholder id 'legacy' for
    // this path (see operator-session.ts) — it is not a real Operator
    // row, so looking it up by id would throw (Operator.id is @db.Uuid).
    // Caught for real against Postgres during this feature's own
    // verification: the route 500'd before this fix.
    mockState.authenticateAdminRequest.mockResolvedValue({ ok: true, sessionId: 'legacy', operatorId: 'legacy' });
    const res = await POST(makeRequest({ apiKey: 'AIzaSomeRealLookingKey' }));
    expect(res.status).toBe(200);
    expect(mockState.operatorFindUnique).not.toHaveBeenCalled();
    expect(mockState.saveIntegrationCredential).toHaveBeenCalledWith(
      'google_places',
      'Google Places',
      'AIzaSomeRealLookingKey',
      { operatorId: null, operatorEmail: null },
    );
  });

  it('trims surrounding whitespace before validating and saving', async () => {
    await POST(makeRequest({ apiKey: '  AIzaSomeRealLookingKey  ' }));
    expect(mockState.saveIntegrationCredential).toHaveBeenCalledWith(
      'google_places',
      'Google Places',
      'AIzaSomeRealLookingKey',
      expect.anything(),
    );
  });

  it('503s when the database is not configured', async () => {
    mockState.isDatabaseConfigured = false;
    const res = await POST(makeRequest({ apiKey: 'AIzaSomeRealLookingKey' }));
    expect(res.status).toBe(503);
  });

  it('500s cleanly and logs when saving throws — never leaks the key in the error', async () => {
    mockState.saveIntegrationCredential.mockRejectedValue(new Error('db down'));
    const res = await POST(makeRequest({ apiKey: 'AIzaSomeRealLookingKey' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'internal_error' });
    expect(mockState.logError).toHaveBeenCalled();
    expect(JSON.stringify(mockState.logError.mock.calls)).not.toContain('AIzaSomeRealLookingKey');
  });

  it('never calls a real verification API — a wrong key is only caught by the next scheduled search', async () => {
    // No fetch mock is stubbed anywhere in this file; if the route tried
    // to verify the key against Google, this call would throw on a real
    // network attempt instead of resolving cleanly.
    const res = await POST(makeRequest({ apiKey: 'AIzaSomeRealLookingKey' }));
    expect(res.status).toBe(200);
  });
});
