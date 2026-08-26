// =============================================================================
// Prospección con IA, Fase C — unit tests for
// PATCH /api/portal/prospecting/campaign/consent.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  getSession: vi.fn(),
  resolveClientFromSession: vi.fn(),
  clientProductFindFirst: vi.fn(),
  campaignFindUnique: vi.fn(),
  campaignUpdate: vi.fn(),
  campaignAuditCreate: vi.fn(),
  logError: vi.fn(),
}));

const mockTx = {
  prospectingCampaign: { update: (...a: unknown[]) => mockState.campaignUpdate(...a) },
  prospectingCampaignAudit: { create: (...a: unknown[]) => mockState.campaignAuditCreate(...a) },
};

vi.mock('@/lib/session', () => ({
  getSession: (...a: unknown[]) => mockState.getSession(...a),
}));

vi.mock('@/lib/portal-session', () => ({
  resolveClientFromSession: (...a: unknown[]) => mockState.resolveClientFromSession(...a),
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

import { PATCH } from '@/app/api/portal/prospecting/campaign/consent/route';

const SESSION_OK = { hasClientAccess: true };
const RESOLVED = { clientId: 'client_1', email: 'a@b.com', source: 'database' as const };
const CLIENT_PRODUCT = { id: 'cp_1', tenantId: 't1' };

function makeRequest(body?: unknown) {
  return { json: async () => body ?? null } as unknown as NextRequest;
}

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.getSession.mockReset().mockResolvedValue(SESSION_OK);
  mockState.resolveClientFromSession.mockReset().mockResolvedValue(RESOLVED);
  mockState.clientProductFindFirst.mockReset().mockResolvedValue(CLIENT_PRODUCT);
  mockState.campaignFindUnique.mockReset().mockResolvedValue({ id: 'camp_1', consentVersion: null });
  mockState.campaignUpdate.mockReset().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'camp_1', consentAcknowledgedAt: null, autoContactPausedAt: null, ...data }),
  );
  mockState.campaignAuditCreate.mockReset();
  mockState.logError.mockReset();
});

describe('PATCH /api/portal/prospecting/campaign/consent', () => {
  it('401s without a client session', async () => {
    mockState.getSession.mockResolvedValue({ hasClientAccess: false });
    const res = await PATCH(makeRequest({ consent: true }));
    expect(res.status).toBe(401);
  });

  it('400s on a malformed body', async () => {
    const res = await PATCH(makeRequest({ consent: 'yes' }));
    expect(res.status).toBe(400);
  });

  it('403s a client without the prospecting product', async () => {
    mockState.clientProductFindFirst.mockResolvedValue(null);
    const res = await PATCH(makeRequest({ consent: true }));
    expect(res.status).toBe(403);
  });

  it('404s when no campaign exists yet — consent needs a saved profile first', async () => {
    mockState.campaignFindUnique.mockResolvedValue(null);
    const res = await PATCH(makeRequest({ consent: true }));
    expect(res.status).toBe(404);
    expect(mockState.campaignUpdate).not.toHaveBeenCalled();
  });

  it('consent:true stamps consentAcknowledgedAt/consentVersion and clears autoContactPausedAt (the resume path)', async () => {
    const res = await PATCH(makeRequest({ consent: true }));
    expect(res.status).toBe(200);
    expect(mockState.campaignUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'camp_1' },
        data: expect.objectContaining({
          consentAcknowledgedAt: expect.any(Date),
          consentVersion: 'v1',
          autoContactPausedAt: null,
        }),
      }),
    );
    expect(mockState.campaignAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'consent_given', actorId: 'client:client_1' }) }),
    );
  });

  it('consent:false clears consentAcknowledgedAt/consentVersion/autoContactPausedAt', async () => {
    await PATCH(makeRequest({ consent: false }));
    expect(mockState.campaignUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { consentAcknowledgedAt: null, consentVersion: null, autoContactPausedAt: null },
      }),
    );
    expect(mockState.campaignAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'consent_revoked' }) }),
    );
  });

  it('503s when the database is not configured', async () => {
    mockState.isDatabaseConfigured = false;
    const res = await PATCH(makeRequest({ consent: true }));
    expect(res.status).toBe(503);
  });

  it('500s cleanly and logs when the transaction throws', async () => {
    mockState.campaignUpdate.mockRejectedValue(new Error('db down'));
    const res = await PATCH(makeRequest({ consent: true }));
    expect(res.status).toBe(500);
    expect(mockState.logError).toHaveBeenCalled();
  });
});
