// =============================================================================
// SEO con IA — unit tests for POST /api/portal/seo/analytics/select-property.
//
// Covers: the ownership/authenticity check (a submitted propertyId must
// actually appear in the live list the connected account can access —
// never trusted blind from the request body).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  resolveClientFromSession: vi.fn(),
  getSession: vi.fn(),
  isDatabaseConfigured: true,
  connectionFindUnique: vi.fn(),
  connectionUpdate: vi.fn(),
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
    googleAnalyticsConnection: {
      findUnique: (...a: unknown[]) => mockState.connectionFindUnique(...a),
      update: (...a: unknown[]) => mockState.connectionUpdate(...a),
    },
  },
}));

vi.mock('@/lib/google-analytics', () => ({
  getValidAccessToken: (...a: unknown[]) => mockState.getValidAccessToken(...a),
  fetchAccessibleProperties: (...a: unknown[]) => mockState.fetchAccessibleProperties(...a),
}));

import { POST } from '@/app/api/portal/seo/analytics/select-property/route';

const RESOLVED = { clientId: 'client_1', email: 'a@b.com', source: 'database' as const };
const PENDING_CONNECTION = {
  id: 'conn_1',
  status: 'pending_property_selection',
  refreshTokenCiphertext: Buffer.from('ct'),
  refreshTokenIv: Buffer.from('iv'),
  refreshTokenTag: Buffer.from('tag'),
};
const LIVE_PROPERTIES = [
  { propertyId: 'properties/1000', displayName: 'negocio.example', accountDisplayName: 'Negocio' },
];

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  mockState.resolveClientFromSession.mockReset().mockResolvedValue(RESOLVED);
  mockState.getSession.mockReset().mockResolvedValue({ hasClientAccess: true });
  mockState.isDatabaseConfigured = true;
  mockState.connectionFindUnique.mockReset().mockResolvedValue(PENDING_CONNECTION);
  mockState.connectionUpdate.mockReset().mockResolvedValue({});
  mockState.getValidAccessToken.mockReset().mockResolvedValue('at_1');
  mockState.fetchAccessibleProperties.mockReset().mockResolvedValue(LIVE_PROPERTIES);
});

describe('POST /api/portal/seo/analytics/select-property', () => {
  it('401s without a client session', async () => {
    mockState.getSession.mockResolvedValueOnce({ hasClientAccess: false });
    const res = await POST(makeRequest({ propertyId: 'properties/1000' }));
    expect(res.status).toBe(401);
  });

  it('400s on a missing body', async () => {
    const res = await POST(makeRequest(null));
    expect(res.status).toBe(400);
  });

  it('409s when the connection is not pending_property_selection', async () => {
    mockState.connectionFindUnique.mockResolvedValueOnce({ ...PENDING_CONNECTION, status: 'active' });
    const res = await POST(makeRequest({ propertyId: 'properties/1000' }));
    expect(res.status).toBe(409);
  });

  it('502s when the stored token cannot be refreshed', async () => {
    mockState.getValidAccessToken.mockResolvedValueOnce(null);
    const res = await POST(makeRequest({ propertyId: 'properties/1000' }));
    expect(res.status).toBe(502);
  });

  it('400s when the submitted propertyId is not in the live accessible list — never trusts the request body blindly', async () => {
    const res = await POST(makeRequest({ propertyId: 'properties/9999' }));
    expect(res.status).toBe(400);
    expect(mockState.connectionUpdate).not.toHaveBeenCalled();
  });

  it('activates the connection with the matched property on success', async () => {
    const res = await POST(makeRequest({ propertyId: 'properties/1000' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, propertyId: 'properties/1000', propertyDisplayName: 'negocio.example' });
    expect(mockState.connectionUpdate).toHaveBeenCalledWith({
      where: { id: 'conn_1' },
      data: { propertyId: 'properties/1000', propertyDisplayName: 'negocio.example', status: 'active' },
    });
  });

  it('401s when the database is not configured (folded into the same unauthorized check as no session)', async () => {
    mockState.isDatabaseConfigured = false;
    const res = await POST(makeRequest({ propertyId: 'properties/1000' }));
    expect(res.status).toBe(401);
  });
});
