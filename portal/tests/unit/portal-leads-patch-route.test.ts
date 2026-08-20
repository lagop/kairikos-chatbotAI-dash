// =============================================================================
// Leads Fase 4 — unit tests for PATCH /api/portal/leads/[id].
// Mirrors the mocking conventions of a plain session+prisma PATCH route
// (see the shape this route copies: google-business/campaigns/[id]).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  getSession: vi.fn(),
  resolveClientFromSession: vi.fn(),
  leadFindUnique: vi.fn(),
  leadUpdate: vi.fn(),
  leadAuditCreate: vi.fn(),
}));

const mockTx = {
  lead: { update: (...args: unknown[]) => mockState.leadUpdate(...args) },
  leadAudit: { create: (...args: unknown[]) => mockState.leadAuditCreate(...args) },
};

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    $transaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
    lead: { findUnique: (...args: unknown[]) => mockState.leadFindUnique(...args) },
  },
}));

vi.mock('@/lib/session', () => ({
  getSession: (...args: unknown[]) => mockState.getSession(...args),
}));

vi.mock('@/lib/portal-session', () => ({
  resolveClientFromSession: (...args: unknown[]) => mockState.resolveClientFromSession(...args),
}));

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

const RESOLVED = { clientId: 'c1', email: 'owner@example.com', source: 'database' as const };

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.getSession.mockReset().mockResolvedValue({ hasClientAccess: true });
  mockState.resolveClientFromSession.mockReset().mockResolvedValue(RESOLVED);
  mockState.leadFindUnique.mockReset();
  mockState.leadUpdate.mockReset().mockResolvedValue({ id: 'lead_1', status: 'contactado' });
  mockState.leadAuditCreate.mockReset();
});

describe('PATCH /api/portal/leads/[id]', () => {
  it('401s when the session has no client access', async () => {
    mockState.getSession.mockResolvedValue({ hasClientAccess: false });
    const { PATCH } = await import('@/app/api/portal/leads/[id]/route');
    const res = await PATCH(makeRequest({ status: 'contactado' }), { params: { id: 'lead_1' } });
    expect(res.status).toBe(401);
    expect(mockState.leadFindUnique).not.toHaveBeenCalled();
  });

  it('400s on an invalid status value', async () => {
    const { PATCH } = await import('@/app/api/portal/leads/[id]/route');
    const res = await PATCH(makeRequest({ status: 'archivado' }), { params: { id: 'lead_1' } });
    expect(res.status).toBe(400);
  });

  it('404s when the lead does not belong to the resolved client (does not leak existence)', async () => {
    mockState.leadFindUnique.mockResolvedValue({ id: 'lead_1', clientId: 'other-client', status: 'nuevo', tenantId: null });
    const { PATCH } = await import('@/app/api/portal/leads/[id]/route');
    const res = await PATCH(makeRequest({ status: 'contactado' }), { params: { id: 'lead_1' } });
    expect(res.status).toBe(404);
    expect(mockState.leadUpdate).not.toHaveBeenCalled();
  });

  it('404s when the lead does not exist at all', async () => {
    mockState.leadFindUnique.mockResolvedValue(null);
    const { PATCH } = await import('@/app/api/portal/leads/[id]/route');
    const res = await PATCH(makeRequest({ status: 'contactado' }), { params: { id: 'missing' } });
    expect(res.status).toBe(404);
  });

  it('409s on an illegal transition (nuevo -> convertido, skipping contactado)', async () => {
    mockState.leadFindUnique.mockResolvedValue({ id: 'lead_1', clientId: 'c1', status: 'nuevo', tenantId: null });
    const { PATCH } = await import('@/app/api/portal/leads/[id]/route');
    const res = await PATCH(makeRequest({ status: 'convertido' }), { params: { id: 'lead_1' } });
    expect(res.status).toBe(409);
    expect(mockState.leadUpdate).not.toHaveBeenCalled();
  });

  it('409s on a transition from a terminal status (descartado -> contactado)', async () => {
    mockState.leadFindUnique.mockResolvedValue({ id: 'lead_1', clientId: 'c1', status: 'descartado', tenantId: null });
    const { PATCH } = await import('@/app/api/portal/leads/[id]/route');
    const res = await PATCH(makeRequest({ status: 'contactado' }), { params: { id: 'lead_1' } });
    expect(res.status).toBe(409);
  });

  it('nuevo -> contactado: updates the row, stamps contactedAt, writes a LeadAudit row', async () => {
    mockState.leadFindUnique.mockResolvedValue({ id: 'lead_1', clientId: 'c1', status: 'nuevo', tenantId: 't1' });
    const { PATCH } = await import('@/app/api/portal/leads/[id]/route');
    const res = await PATCH(makeRequest({ status: 'contactado' }), { params: { id: 'lead_1' } });
    expect(res.status).toBe(200);
    expect(mockState.leadUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'lead_1' },
        data: expect.objectContaining({ status: 'contactado', contactedAt: expect.any(Date) }),
      }),
    );
    expect(mockState.leadAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          leadId: 'lead_1',
          clientId: 'c1',
          tenantId: 't1',
          action: 'marked_contacted',
          statusBefore: 'nuevo',
          statusAfter: 'contactado',
          actorId: 'client:c1',
        }),
      }),
    );
  });

  it('contactado -> convertido: legal, stamps convertedAt', async () => {
    mockState.leadFindUnique.mockResolvedValue({ id: 'lead_1', clientId: 'c1', status: 'contactado', tenantId: null });
    mockState.leadUpdate.mockResolvedValue({ id: 'lead_1', status: 'convertido' });
    const { PATCH } = await import('@/app/api/portal/leads/[id]/route');
    const res = await PATCH(makeRequest({ status: 'convertido' }), { params: { id: 'lead_1' } });
    expect(res.status).toBe(200);
    expect(mockState.leadUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'convertido', convertedAt: expect.any(Date) }) }),
    );
    expect(mockState.leadAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'marked_converted', statusBefore: 'contactado', statusAfter: 'convertido' }) }),
    );
  });

  it('nuevo -> descartado: legal side-exit', async () => {
    mockState.leadFindUnique.mockResolvedValue({ id: 'lead_1', clientId: 'c1', status: 'nuevo', tenantId: null });
    mockState.leadUpdate.mockResolvedValue({ id: 'lead_1', status: 'descartado' });
    const { PATCH } = await import('@/app/api/portal/leads/[id]/route');
    const res = await PATCH(makeRequest({ status: 'descartado' }), { params: { id: 'lead_1' } });
    expect(res.status).toBe(200);
    expect(mockState.leadUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'descartado', discardedAt: expect.any(Date) }) }),
    );
  });

  it('contactado -> descartado: legal side-exit', async () => {
    mockState.leadFindUnique.mockResolvedValue({ id: 'lead_1', clientId: 'c1', status: 'contactado', tenantId: null });
    mockState.leadUpdate.mockResolvedValue({ id: 'lead_1', status: 'descartado' });
    const { PATCH } = await import('@/app/api/portal/leads/[id]/route');
    const res = await PATCH(makeRequest({ status: 'descartado' }), { params: { id: 'lead_1' } });
    expect(res.status).toBe(200);
    expect(mockState.leadAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'marked_discarded', statusBefore: 'contactado', statusAfter: 'descartado' }) }),
    );
  });
});
