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
  chatbotClientFindUnique: vi.fn(),
  isProductContracted: vi.fn(),
  sendNewLeadEmail: vi.fn(),
  logError: vi.fn(),
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
    chatbotClient: { findUnique: (...args: unknown[]) => mockState.chatbotClientFindUnique(...args) },
  },
}));

vi.mock('@/lib/client-product-access', () => ({
  isProductContracted: (...args: unknown[]) => mockState.isProductContracted(...args),
}));

vi.mock('@/lib/leads-email', () => ({
  sendNewLeadEmail: (...args: unknown[]) => mockState.sendNewLeadEmail(...args),
}));

vi.mock('@/lib/observability', () => ({
  logError: (...args: unknown[]) => mockState.logError(...args),
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
  // Echoes back the fields the route asked to create, like the real
  // Prisma `create()` — Fase 6's notification reads score/channel/etc
  // off this return value, so a fixed stub would silently pass undefined
  // for all of them.
  mockState.leadCreate.mockReset().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'lead_1', ...data }),
  );
  mockState.leadUpdate.mockReset().mockResolvedValue({ id: 'lead_existing', clientId: 'c1', tenantId: 't1' });
  mockState.leadAuditCreate.mockReset();
  mockState.chatbotClientFindUnique.mockReset().mockResolvedValue({
    email: 'aurora@example.com',
    name: 'Aurora Owner',
    companyName: 'Peluquería Aurora',
  });
  mockState.isProductContracted.mockReset().mockResolvedValue(true);
  mockState.sendNewLeadEmail.mockReset().mockResolvedValue({ ok: true, messageId: 'msg_1' });
  mockState.logError.mockReset();
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
      scoreReason: 'razón original',
      channel: 'telegram',
    });
    const { POST } = await import('@/app/api/internal/leads/route');
    const res = await POST(
      makeRequest(
        {
          conversationId: 'conv_1',
          summary: 'ahora pidió precio exacto',
          score: 90,
          scoreReason: 'pidió precio exacto y disponibilidad',
        },
        { 'x-kairikos-internal-key': VALID_KEY },
      ),
    );
    expect(res.status).toBe(200);
    const resBody = await res.json();
    expect(resBody).toEqual({ ok: true, leadId: 'lead_existing' });

    expect(mockState.leadUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'lead_existing' },
        data: expect.objectContaining({
          summary: 'ahora pidió precio exacto',
          score: 90,
          scoreReason: 'pidió precio exacto y disponibilidad',
        }),
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

  it('Fase 6 — emails the client once, on a genuinely new lead, when they have the leads product', async () => {
    mockState.conversationFindUnique.mockResolvedValue(conversation);
    mockState.leadFindFirst.mockResolvedValue(null);
    const { POST } = await import('@/app/api/internal/leads/route');
    const res = await POST(
      makeRequest(
        {
          conversationId: 'conv_1',
          contactName: 'Marcos',
          summary: 'quiere presupuesto',
          score: 80,
          scoreReason: 'Pide precio exacto y disponibilidad esta semana.',
          channel: 'telegram',
        },
        { 'x-kairikos-internal-key': VALID_KEY },
      ),
    );
    expect(res.status).toBe(200);
    expect(mockState.isProductContracted).toHaveBeenCalledWith(expect.anything(), 'c1', 'leads');
    expect(mockState.sendNewLeadEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'aurora@example.com',
        businessName: 'Peluquería Aurora',
        contactName: 'Marcos',
        score: 80,
        scoreReason: 'Pide precio exacto y disponibilidad esta semana.',
        channel: 'telegram',
      }),
    );
  });

  it('Fase 6 — does NOT email when the client does not have the leads product', async () => {
    mockState.conversationFindUnique.mockResolvedValue(conversation);
    mockState.leadFindFirst.mockResolvedValue(null);
    mockState.isProductContracted.mockResolvedValue(false);
    const { POST } = await import('@/app/api/internal/leads/route');
    await POST(makeRequest({ conversationId: 'conv_1', summary: 'x' }, { 'x-kairikos-internal-key': VALID_KEY }));
    expect(mockState.sendNewLeadEmail).not.toHaveBeenCalled();
  });

  it('Fase 6 — never re-notifies when refreshing an existing "nuevo" lead', async () => {
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
    await POST(
      makeRequest({ conversationId: 'conv_1', summary: 'ahora pidió precio exacto' }, { 'x-kairikos-internal-key': VALID_KEY }),
    );
    expect(mockState.sendNewLeadEmail).not.toHaveBeenCalled();
    expect(mockState.isProductContracted).not.toHaveBeenCalled();
  });

  it('Fase 6 — a failed notification never fails the request the ingestion is waiting on', async () => {
    mockState.conversationFindUnique.mockResolvedValue(conversation);
    mockState.leadFindFirst.mockResolvedValue(null);
    mockState.isProductContracted.mockRejectedValue(new Error('db down'));
    const { POST } = await import('@/app/api/internal/leads/route');
    const res = await POST(makeRequest({ conversationId: 'conv_1', summary: 'x' }, { 'x-kairikos-internal-key': VALID_KEY }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, leadId: 'lead_1' });
    expect(mockState.logError).toHaveBeenCalled();
  });
});
