// =============================================================================
// SEO con IA — unit tests for GET /api/portal/seo/analytics/properties.
// Used by SeoAnalyticsPicker on mount, not during page SSR.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const TEST_CLIENT_PRODUCT_ID = '11111111-1111-4111-8111-111111111111';

const mockState = vi.hoisted(() => ({
  resolveClientFromSession: vi.fn(),
  getSession: vi.fn(),
  isDatabaseConfigured: true,
  connectionFindUnique: vi.fn(),
  getValidAccessToken: vi.fn(),
  fetchAccessibleProperties: vi.fn(),
}));

vi.mock('@/lib/client-product-access', () => ({
  // Fase 2 multi-instancia — la ruta resuelve la contratación antes de tocar
  // la conexión de GA4, porque la conexión es de UNA web.
  resolveContractedInstance: async () => ({
    clientProductId: TEST_CLIENT_PRODUCT_ID,
    clientId: 'client_1',
    clientSiteId: null,
    tenantId: 'tenant_1',
    code: 'seo',
    tier: 'standard',
    status: 'active',
  }),
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

function makeRequest(clientProductId?: string) {
  // Fase 2 multi-instancia: la ruta lee ?clientProductId, asi que el fixture
  // necesita un nextUrl de verdad — un NextRequest real siempre lo tiene.
  const url = new URL('https://portal.kairikos.test/api/portal/seo/analytics/properties');
  if (clientProductId) url.searchParams.set('clientProductId', clientProductId);
  return { url: url.toString(), nextUrl: url } as unknown as NextRequest;
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
