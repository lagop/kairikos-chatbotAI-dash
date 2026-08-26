// =============================================================================
// Prospección con IA, Fase A — unit tests for PATCH /api/portal/prospecting/campaign.
//
// Client self-serve, not operator-managed — see the route's own header
// for why. Covers: auth, the 'prospecting' product gate, lazy creation
// on first save (with the tier's TIER_LEAD_CAP), update on subsequent
// saves, and the audit trail for both.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  getSession: vi.fn(),
  resolveClientFromSession: vi.fn(),
  clientProductFindFirst: vi.fn(),
  campaignFindUnique: vi.fn(),
  campaignCreate: vi.fn(),
  campaignUpdate: vi.fn(),
  campaignAuditCreate: vi.fn(),
  logError: vi.fn(),
}));

const mockTx = {
  prospectingCampaign: {
    create: (...a: unknown[]) => mockState.campaignCreate(...a),
    update: (...a: unknown[]) => mockState.campaignUpdate(...a),
  },
  prospectingCampaignAudit: { create: (...a: unknown[]) => mockState.campaignAuditCreate(...a) },
};

vi.mock('@/lib/session', () => ({
  getSession: (...a: unknown[]) => mockState.getSession(...a),
}));

vi.mock('@/lib/portal-session', () => ({
  resolveClientFromSession: (...a: unknown[]) => mockState.resolveClientFromSession(...a),
}));

vi.mock('@/lib/prospecting', () => ({
  TIER_LEAD_CAP: { solo: 100, team: 300, business: 800 },
}));

vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    clientProduct: { findFirst: (...a: unknown[]) => mockState.clientProductFindFirst(...a) },
    prospectingCampaign: { findUnique: (...a: unknown[]) => mockState.campaignFindUnique(...a) },
    $transaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
  },
}));

import { PATCH } from '@/app/api/portal/prospecting/campaign/route';

const SESSION_OK = { hasClientAccess: true };
const RESOLVED = { clientId: 'client_1', email: 'a@b.com', source: 'database' as const };
const CLIENT_PRODUCT = { id: 'cp_1', tenantId: 't1', product: { tier: 'team' } };

function makeRequest(body?: unknown) {
  return { json: async () => body ?? null } as unknown as NextRequest;
}

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.getSession.mockReset().mockResolvedValue(SESSION_OK);
  mockState.resolveClientFromSession.mockReset().mockResolvedValue(RESOLVED);
  mockState.clientProductFindFirst.mockReset().mockResolvedValue(CLIENT_PRODUCT);
  mockState.campaignFindUnique.mockReset().mockResolvedValue(null);
  mockState.campaignCreate.mockReset().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'camp_1', ...data }),
  );
  mockState.campaignUpdate.mockReset().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'camp_1', category: 'x', locationQuery: 'y', radiusMeters: 10000, ...data }),
  );
  mockState.campaignAuditCreate.mockReset();
  mockState.logError.mockReset();
});

const VALID_BODY = { category: 'ferretería', locationQuery: 'Las Palmas de Gran Canaria', radiusMeters: 15000 };

describe('PATCH /api/portal/prospecting/campaign', () => {
  it('401s without a client session', async () => {
    mockState.getSession.mockResolvedValue({ hasClientAccess: false });
    const res = await PATCH(makeRequest(VALID_BODY));
    expect(res.status).toBe(401);
  });

  it('400s on a malformed body', async () => {
    const res = await PATCH(makeRequest({ category: '' }));
    expect(res.status).toBe(400);
  });

  it('403s a client without the prospecting product', async () => {
    mockState.clientProductFindFirst.mockResolvedValue(null);
    const res = await PATCH(makeRequest(VALID_BODY));
    expect(res.status).toBe(403);
    expect(mockState.campaignCreate).not.toHaveBeenCalled();
  });

  it('creates a new campaign with the tier-derived monthlyLeadCap on first save', async () => {
    const res = await PATCH(makeRequest(VALID_BODY));
    expect(res.status).toBe(200);
    expect(mockState.campaignCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          clientId: 'client_1',
          clientProductId: 'cp_1',
          category: 'ferretería',
          locationQuery: 'Las Palmas de Gran Canaria',
          radiusMeters: 15000,
          monthlyLeadCap: 300, // tier 'team'
        }),
      }),
    );
    expect(mockState.campaignAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'created', actorId: 'client:client_1' }) }),
    );
    expect(mockState.campaignUpdate).not.toHaveBeenCalled();
  });

  it('falls back to the solo cap for an unrecognised tier', async () => {
    mockState.clientProductFindFirst.mockResolvedValue({ ...CLIENT_PRODUCT, product: { tier: 'unknown_tier' } });
    await PATCH(makeRequest(VALID_BODY));
    expect(mockState.campaignCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ monthlyLeadCap: 100 }) }),
    );
  });

  it('updates the existing campaign on a subsequent save, never creates a second one', async () => {
    mockState.campaignFindUnique.mockResolvedValue({
      id: 'camp_1',
      category: 'panadería',
      locationQuery: 'Tenerife',
      radiusMeters: 10000,
    });
    const res = await PATCH(makeRequest(VALID_BODY));
    expect(res.status).toBe(200);
    expect(mockState.campaignUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'camp_1' },
        data: expect.objectContaining({ category: 'ferretería', locationQuery: 'Las Palmas de Gran Canaria' }),
      }),
    );
    expect(mockState.campaignCreate).not.toHaveBeenCalled();
    expect(mockState.campaignAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'profile_updated',
          before: { category: 'panadería', locationQuery: 'Tenerife', radiusMeters: 10000 },
        }),
      }),
    );
  });

  it('500s cleanly and logs when the transaction throws', async () => {
    mockState.campaignCreate.mockRejectedValue(new Error('db down'));
    const res = await PATCH(makeRequest(VALID_BODY));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'internal_error' });
    expect(mockState.logError).toHaveBeenCalled();
  });
});
