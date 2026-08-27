// =============================================================================
// SEO con IA, Fase C — unit tests for
// PATCH /api/admin/portal/seo/[clientId]/content-drafts/[draftId]. Same
// conventions as seo-audit-route.test.ts, including the legacy-auth
// regression coverage.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  authenticateAdminRequest: vi.fn(),
  operatorFindUnique: vi.fn(),
  draftFindFirst: vi.fn(),
  draftUpdate: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...a: unknown[]) => mockState.authenticateAdminRequest(...a),
}));

vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    operator: { findUnique: (...a: unknown[]) => mockState.operatorFindUnique(...a) },
    seoContentDraft: {
      findFirst: (...a: unknown[]) => mockState.draftFindFirst(...a),
      update: (...a: unknown[]) => mockState.draftUpdate(...a),
    },
  },
}));

import { PATCH } from '@/app/api/admin/portal/seo/[clientId]/content-drafts/[draftId]/route';

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

async function patch(clientId: string, draftId: string, body: unknown) {
  return PATCH(makeRequest(body), { params: { clientId, draftId } });
}

const DRAFT = { id: 'draft_1', status: 'drafted' };

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue({ ok: true, sessionId: 's1', operatorId: 'op_1' });
  mockState.operatorFindUnique.mockReset().mockResolvedValue({ email: 'op@kairikos.com' });
  mockState.draftFindFirst.mockReset().mockResolvedValue(DRAFT);
  mockState.draftUpdate.mockReset().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ ...DRAFT, ...data }),
  );
  mockState.logError.mockReset();
});

describe('PATCH /api/admin/portal/seo/[clientId]/content-drafts/[draftId]', () => {
  it('401s without a valid admin session', async () => {
    mockState.authenticateAdminRequest.mockResolvedValue({ ok: false });
    const res = await patch('client_1', 'draft_1', { action: 'approve' });
    expect(res.status).toBe(401);
    expect(mockState.draftFindFirst).not.toHaveBeenCalled();
  });

  it('400s on an unknown action', async () => {
    const res = await patch('client_1', 'draft_1', { action: 'delete' });
    expect(res.status).toBe(400);
    expect(mockState.draftFindFirst).not.toHaveBeenCalled();
  });

  it("400s when action is 'reject' without a rejectionReason", async () => {
    const res = await patch('client_1', 'draft_1', { action: 'reject' });
    expect(res.status).toBe(400);
  });

  it('404s when the draft does not exist for this client', async () => {
    mockState.draftFindFirst.mockResolvedValue(null);
    const res = await patch('client_1', 'draft_missing', { action: 'approve' });
    expect(res.status).toBe(404);
  });

  it("409s when the draft is not currently 'drafted' (e.g. still pending_generation)", async () => {
    mockState.draftFindFirst.mockResolvedValue({ ...DRAFT, status: 'pending_generation' });
    const res = await patch('client_1', 'draft_1', { action: 'approve' });
    expect(res.status).toBe(409);
    expect(mockState.draftUpdate).not.toHaveBeenCalled();
  });

  it('409s when the draft was already approved — never re-decides a settled draft', async () => {
    mockState.draftFindFirst.mockResolvedValue({ ...DRAFT, status: 'approved' });
    const res = await patch('client_1', 'draft_1', { action: 'reject', rejectionReason: 'cambio de opinión' });
    expect(res.status).toBe(409);
    expect(mockState.draftUpdate).not.toHaveBeenCalled();
  });

  it('approves a drafted row, stamping reviewedBy/reviewedAt from the operator session', async () => {
    const res = await patch('client_1', 'draft_1', { action: 'approve' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, draftId: 'draft_1', status: 'approved' });
    expect(mockState.draftUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'draft_1' },
        data: expect.objectContaining({ status: 'approved', reviewedBy: 'op@kairikos.com', rejectionReason: null }),
      }),
    );
  });

  it('rejects a drafted row with the given reason', async () => {
    const res = await patch('client_1', 'draft_1', { action: 'reject', rejectionReason: 'tono equivocado' });
    expect(res.status).toBe(200);
    expect(mockState.draftUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'rejected', rejectionReason: 'tono equivocado' }),
      }),
    );
  });

  it('the legacy KAIA_OPERATOR_API_KEY auth path reviews with a fallback reviewedBy instead of crashing', async () => {
    mockState.authenticateAdminRequest.mockResolvedValue({ ok: true, sessionId: 'legacy', operatorId: 'legacy' });
    const res = await patch('client_1', 'draft_1', { action: 'approve' });
    expect(res.status).toBe(200);
    expect(mockState.operatorFindUnique).not.toHaveBeenCalled();
    expect(mockState.draftUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reviewedBy: 'legacy_operator' }) }),
    );
  });

  it('503s when the database is not configured', async () => {
    mockState.isDatabaseConfigured = false;
    const res = await patch('client_1', 'draft_1', { action: 'approve' });
    expect(res.status).toBe(503);
  });

  it('500s cleanly and logs when the update throws', async () => {
    mockState.draftUpdate.mockRejectedValue(new Error('db down'));
    const res = await patch('client_1', 'draft_1', { action: 'approve' });
    expect(res.status).toBe(500);
    expect(mockState.logError).toHaveBeenCalled();
  });

  it('GET is not allowed', async () => {
    const { GET } = await import('@/app/api/admin/portal/seo/[clientId]/content-drafts/[draftId]/route');
    const res = GET();
    expect(res.status).toBe(405);
  });
});
