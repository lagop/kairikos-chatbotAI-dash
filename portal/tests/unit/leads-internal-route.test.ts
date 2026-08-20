// =============================================================================
// Leads Fase 3 — unit tests for POST /api/internal/leads.
// Same mocking conventions as channels-telegram-internal-routes.test.ts.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  conversationFindUnique: vi.fn(),
  leadFindFirst: vi.fn(),
  leadCreate: vi.fn(),
  leadUpdate: vi.fn(),
  leadAuditCreate: vi.fn(),
}));

const mockTx = {
  lead: {
    create: (...args: unknown[]) => mockState.leadCreate(...args),
    update: (...args: unknown[]) => mockState.leadUpdate(...args),
  },
  leadAudit: { create: (...args: unknown[]) => mockState.leadAuditCreate(...args) },
};

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    $transaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
    chatbotConversation: { findUnique: (...args: unknown[]) => mockState.conversationFindUnique(...args) },
    lead: { findFirst: (...args: unknown[]) => mockState.leadFindFirst(...args) },
  },
}));

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return {
    json: async () => body,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

const VALID_KEY = 'test_portal_api_key';
const conversation = { id: 'conv_1', clientId: 'c1', tenantId: 't1' };

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.conversationFindUnique.mockReset();
  mockState.leadFindFirst.mockReset();
  mockState.leadCreate.mockReset().mockResolvedValue({ id: 'lead_1', clientId: 'c1', tenantId: 't1' });
  mockState.leadUpdate.mockReset().mockResolvedValue({ id: 'lead_existing', clientId: 'c1', tenantId: 't1' });
  mockState.leadAuditCreate.mockReset();
  process.env.PORTAL_API_KEY = VALID_KEY;
});

afterEach(() => {
  delete process.env.PORTAL_API_KEY;
});

describe('POST /api/internal/leads', () => {
  it('401s without a matching internal key', async () => {
    const { POST } = await import('@/app/api/internal/leads/route');
    const res = await POST(makeRequest({ conversationId: 'conv_1', summary: 'quiere presupuesto' }));
    expect(res.status).toBe(401);
    expect(mockState.conversationFindUnique).not.toHaveBeenCalled();
  });

  it('400s on an invalid body (missing conversationId)', async () => {
    const { POST } = await import('@/app/api/internal/leads/route');
    const res = await POST(makeRequest({ summary: 'quiere presupuesto' }, { 'x-kairikos-internal-key': VALID_KEY }));
    expect(res.status).toBe(400);
  });

  it('400s when score is out of the 0-100 range', async () => {
    const { POST } = await import('@/app/api/internal/leads/route');
    const res = await POST(
      makeRequest({ conversationId: 'conv_1', score: 150 }, { 'x-kairikos-internal-key': VALID_KEY }),
    );
    expect(res.status).toBe(400);
  });

  it('404s when the conversationId does not match any ChatbotConversation', async () => {
    mockState.conversationFindUnique.mockResolvedValue(null);
    const { POST } = await import('@/app/api/internal/leads/route');
    const res = await POST(
      makeRequest({ conversationId: 'conv_missing', summary: 'x' }, { 'x-kairikos-internal-key': VALID_KEY }),
    );
    expect(res.status).toBe(404);
  });

  it('creates a new Lead + LeadAudit(created) when none exists yet for this conversation', async () => {
    mockState.conversationFindUnique.mockResolvedValue(conversation);
    mockState.leadFindFirst.mockResolvedValue(null);
    const { POST } = await import('@/app/api/internal/leads/route');
    const res = await POST(
      makeRequest(
        { conversationId: 'conv_1', contactEmail: 'ana@example.com', summary: 'quiere presupuesto', score: 80, channel: 'telegram' },
        { 'x-kairikos-internal-key': VALID_KEY },
      ),
    );
    expect(res.status).toBe(200);
    const resBody = await res.json();
    expect(resBody).toEqual({ ok: true, leadId: 'lead_1' });

    expect(mockState.leadCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          clientId: 'c1',
          tenantId: 't1',
          conversationId: 'conv_1',
          contactEmail: 'ana@example.com',
          summary: 'quiere presupuesto',
          score: 80,
          channel: 'telegram',
        }),
      }),
    );
    expect(mockState.leadAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          leadId: 'lead_1',
          action: 'created',
          statusBefore: null,
          statusAfter: 'nuevo',
          actorId: 'system:n8n',
        }),
      }),
    );
    expect(mockState.leadUpdate).not.toHaveBeenCalled();
  });

  it('refreshes the existing "nuevo" Lead + LeadAudit(refreshed) instead of creating a duplicate', async () => {
    mockState.conversationFindUnique.mockResolvedValue(conversation);
    mockState.leadFindFirst.mockResolvedValue({
      id: 'lead_existing',
      clientId: 'c1',
      tenantId: 't1',
      status: 'nuevo',
      contactName: null,
      contactPhone: null,
      contactEmail: null,
      summary: 'primer mensaje',
      score: 40,
      channel: 'telegram',
    });
    const { POST } = await import('@/app/api/internal/leads/route');
    const res = await POST(
      makeRequest(
        { conversationId: 'conv_1', summary: 'ahora pidió precio exacto', score: 90 },
        { 'x-kairikos-internal-key': VALID_KEY },
      ),
    );
    expect(res.status).toBe(200);
    const resBody = await res.json();
    expect(resBody).toEqual({ ok: true, leadId: 'lead_existing' });

    expect(mockState.leadUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'lead_existing' },
        data: expect.objectContaining({ summary: 'ahora pidió precio exacto', score: 90 }),
      }),
    );
    expect(mockState.leadAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          leadId: 'lead_existing',
          action: 'refreshed',
          statusBefore: 'nuevo',
          statusAfter: 'nuevo',
          actorId: 'system:n8n',
        }),
      }),
    );
    expect(mockState.leadCreate).not.toHaveBeenCalled();
  });

  it('creates a fresh Lead when the prior one for this conversation already moved past "nuevo"', async () => {
    mockState.conversationFindUnique.mockResolvedValue(conversation);
    // findFirst is scoped to status: 'nuevo' in the route — a lead already
    // at 'contactado' would never be returned by that query, so the route
    // falls through to create() instead of reopening it.
    mockState.leadFindFirst.mockResolvedValue(null);
    const { POST } = await import('@/app/api/internal/leads/route');
    await POST(
      makeRequest({ conversationId: 'conv_1', summary: 'nuevo interés, distinto al anterior' }, { 'x-kairikos-internal-key': VALID_KEY }),
    );
    expect(mockState.leadFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { conversationId: 'conv_1', status: 'nuevo' } }),
    );
    expect(mockState.leadCreate).toHaveBeenCalled();
    expect(mockState.leadUpdate).not.toHaveBeenCalled();
  });
});
