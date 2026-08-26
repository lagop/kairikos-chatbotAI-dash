// =============================================================================
// Prospección con IA, Fase B — unit tests for
// PATCH /api/internal/leads/[id]/enrich. Same mocking conventions as
// leads-internal-route.test.ts (the sibling POST /api/internal/leads route).
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  leadFindUnique: vi.fn(),
  leadUpdate: vi.fn(),
  leadAuditCreate: vi.fn(),
}));

const mockTx = {
  lead: { update: (...a: unknown[]) => mockState.leadUpdate(...a) },
  leadAudit: { create: (...a: unknown[]) => mockState.leadAuditCreate(...a) },
};

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    $transaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
    lead: { findUnique: (...a: unknown[]) => mockState.leadFindUnique(...a) },
  },
}));

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return {
    json: async () => body,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

const VALID_KEY = 'test_portal_api_key';
const EXISTING_LEAD = {
  id: 'lead_1',
  clientId: 'client_1',
  tenantId: 't1',
  status: 'nuevo',
  contactName: 'Negocio Encontrado',
  contactPhone: '+34922000000',
  contactEmail: null,
  scoreReason: null,
};

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.leadFindUnique.mockReset().mockResolvedValue(EXISTING_LEAD);
  mockState.leadUpdate.mockReset().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ ...EXISTING_LEAD, ...data }),
  );
  mockState.leadAuditCreate.mockReset();
  process.env.PORTAL_API_KEY = VALID_KEY;
});

afterEach(() => {
  delete process.env.PORTAL_API_KEY;
});

async function patch(id: string, body: unknown, headers: Record<string, string> = {}) {
  const { PATCH } = await import('@/app/api/internal/leads/[id]/enrich/route');
  return PATCH(makeRequest(body, headers), { params: { id } });
}

describe('PATCH /api/internal/leads/[id]/enrich', () => {
  it('401s without a matching internal key', async () => {
    const res = await patch('lead_1', { contactEmail: 'ana@example.com' });
    expect(res.status).toBe(401);
    expect(mockState.leadFindUnique).not.toHaveBeenCalled();
  });

  it('400s on an empty body — at least one field is required', async () => {
    const res = await patch('lead_1', {}, { 'x-kairikos-internal-key': VALID_KEY });
    expect(res.status).toBe(400);
    expect(mockState.leadFindUnique).not.toHaveBeenCalled();
  });

  it('400s on an invalid email', async () => {
    const res = await patch('lead_1', { contactEmail: 'not-an-email' }, { 'x-kairikos-internal-key': VALID_KEY });
    expect(res.status).toBe(400);
  });

  it('404s when the lead id does not exist', async () => {
    mockState.leadFindUnique.mockResolvedValue(null);
    const res = await patch('lead_missing', { contactEmail: 'ana@example.com' }, { 'x-kairikos-internal-key': VALID_KEY });
    expect(res.status).toBe(404);
  });

  it('merges only the provided fields, leaving the rest untouched', async () => {
    const res = await patch(
      'lead_1',
      { contactEmail: 'ana@ferreteria.example' },
      { 'x-kairikos-internal-key': VALID_KEY },
    );
    expect(res.status).toBe(200);
    const resBody = await res.json();
    expect(resBody).toEqual({ ok: true, leadId: 'lead_1' });

    expect(mockState.leadUpdate).toHaveBeenCalledWith({
      where: { id: 'lead_1' },
      data: {
        contactEmail: 'ana@ferreteria.example',
        contactPhone: EXISTING_LEAD.contactPhone,
        contactName: EXISTING_LEAD.contactName,
        scoreReason: EXISTING_LEAD.scoreReason,
      },
    });
  });

  it('writes a LeadAudit(enriched) that does not change lead status', async () => {
    await patch('lead_1', { contactPhone: '+34611223344' }, { 'x-kairikos-internal-key': VALID_KEY });
    expect(mockState.leadAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          leadId: 'lead_1',
          action: 'enriched',
          statusBefore: 'nuevo',
          statusAfter: 'nuevo',
          actorId: 'system:n8n',
        }),
      }),
    );
  });

  it('503s when the database is not configured', async () => {
    mockState.isDatabaseConfigured = false;
    const res = await patch('lead_1', { contactEmail: 'ana@example.com' }, { 'x-kairikos-internal-key': VALID_KEY });
    expect(res.status).toBe(503);
  });

  it('GET is not allowed', async () => {
    const { GET } = await import('@/app/api/internal/leads/[id]/enrich/route');
    const res = GET();
    expect(res.status).toBe(405);
  });
});
