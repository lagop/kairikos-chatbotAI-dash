// =============================================================================
// SEO con IA — unit tests for GET /api/portal/seo/analytics/properties.
// Used by SeoAnalyticsPicker on mount, not during page SSR.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  resolveClientFromSession: vi.fn(),
  getSession: vi.fn(),
  isDatabaseConfigured: true,
  connectionFindUnique: vi.fn(),
  getValidAccessToken: vi.fn(),
  fetchAccessibleProperties: vi.fn(),
}));

vi.mock('@/lib/portal-session', () => ({
  resolveClientFromSession: (...a: unknown[]) => mockState.resolveClientFromSession(...a),
}));

vi.mock('@/lib/session', () => ({
  getSession: (...a: unknown[]) => mockState.getSession(...a),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    googleAnalyticsConnection: { findUnique: (...a: unknown[]) => mockState.connectionFindUnique(...a) },
  },
}));

vi.mock('@/lib/google-analytics', () => ({
  getValidAccessToken: (...a: unknown[]) => mockState.getValidAccessToken(...a),
  fetchAccessibleProperties: (...a: unknown[]) => mockState.fetchAccessibleProperties(...a),
}));

import { GET } from '@/app/api/portal/seo/analytics/properties/route';

const RESOLVED = { clientId: 'client_1', email: 'a@b.com', source: 'database' as const };
const PENDING_CONNECTION = {
  id: 'conn_1',
  status: 'pending_property_selection',
  refreshTokenCiphertext: Buffer.from('ct'),
  refreshTokenIv: Buffer.from('iv'),
  refreshTokenTag: Buffer.from('tag'),
};

function makeRequest() {
  return {} as unknown as NextRequest;
}

beforeEach(() => {
  mockState.resolveClientFromSession.mockReset().mockResolvedValue(RESOLVED);
  mockState.getSession.mockReset().mockResolvedValue({ hasClientAccess: true });
  mockState.isDatabaseConfigured = true;
  mockState.connectionFindUnique.mockReset().mockResolvedValue(PENDING_CONNECTION);
  mockState.getValidAccessToken.mockReset().mockResolvedValue('at_1');
  mockState.fetchAccessibleProperties.mockReset().mockResolvedValue([
    { propertyId: 'properties/1000', displayName: 'negocio.example', accountDisplayName: 'Negocio' },
  ]);
});

describe('GET /api/portal/seo/analytics/properties', () => {
  it('401s without a client session', async () => {
    mockState.getSession.mockResolvedValueOnce({ hasClientAccess: false });
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('409s when there is no connection at all', async () => {
    mockState.connectionFindUnique.mockResolvedValueOnce(null);
    const res = await GET(makeRequest());
    expect(res.status).toBe(409);
    expect(mockState.getValidAccessToken).not.toHaveBeenCalled();
  });

  it('409s when the connection is already active — nothing left to pick', async () => {
    mockState.connectionFindUnique.mockResolvedValueOnce({ ...PENDING_CONNECTION, status: 'active' });
    const res = await GET(makeRequest());
    expect(res.status).toBe(409);
  });

  it('502s when the stored token cannot be refreshed', async () => {
    mockState.getValidAccessToken.mockResolvedValueOnce(null);
    const res = await GET(makeRequest());
    expect(res.status).toBe(502);
  });

  it('returns the live property list on success', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ properties: [{ propertyId: 'properties/1000', displayName: 'negocio.example', accountDisplayName: 'Negocio' }] });
  });
});
