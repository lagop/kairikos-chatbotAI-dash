// =============================================================================
// Canales Fase 4 — unit tests for:
//   POST /api/internal/channels/web/context
//   POST /api/internal/channels/web/message
// Both routes are called by n8n, not the portal's own session — auth is
// the shared PORTAL_API_KEY secret (internal-auth.ts), exercised for
// real here (not mocked) since it's a pure function over
// process.env + request headers.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  embedFindUnique: vi.fn(),
  clientFindUnique: vi.fn(),
  stepFindFirst: vi.fn(),
  conversationFindUnique: vi.fn(),
  conversationCreate: vi.fn(),
  conversationUpdate: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    chatWebEmbed: { findUnique: (...args: unknown[]) => mockState.embedFindUnique(...args) },
    chatbotClient: { findUnique: (...args: unknown[]) => mockState.clientFindUnique(...args) },
    chatbotConfigStep: { findFirst: (...args: unknown[]) => mockState.stepFindFirst(...args) },
    chatbotConversation: {
      findUnique: (...args: unknown[]) => mockState.conversationFindUnique(...args),
      create: (...args: unknown[]) => mockState.conversationCreate(...args),
      update: (...args: unknown[]) => mockState.conversationUpdate(...args),
    },
  },
}));

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return {
    json: async () => body,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

const VALID_KEY = 'test_portal_api_key';

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.embedFindUnique.mockReset();
  mockState.clientFindUnique.mockReset().mockResolvedValue({ companyName: 'Clínica Orly', name: 'Orly' });
  mockState.stepFindFirst.mockReset().mockResolvedValue(null);
  mockState.conversationFindUnique.mockReset();
  mockState.conversationCreate.mockReset().mockResolvedValue({ id: 'conv_1' });
  mockState.conversationUpdate.mockReset().mockResolvedValue({ id: 'conv_1' });
  process.env.PORTAL_API_KEY = VALID_KEY;
});

afterEach(() => {
  delete process.env.PORTAL_API_KEY;
});

describe('POST /api/internal/channels/web/context', () => {
  it('401s without a matching x-kairikos-internal-key header', async () => {
    const { POST } = await import('@/app/api/internal/channels/web/context/route');
    const res = await POST(makeRequest({ publicToken: 'wgt_1' }));
    expect(res.status).toBe(401);
    expect(mockState.embedFindUnique).not.toHaveBeenCalled();
  });

  it('500s when PORTAL_API_KEY is unset (fail closed)', async () => {
    delete process.env.PORTAL_API_KEY;
    const { POST } = await import('@/app/api/internal/channels/web/context/route');
    const res = await POST(makeRequest({ publicToken: 'wgt_1' }, { 'x-kairikos-internal-key': VALID_KEY }));
    expect(res.status).toBe(500);
  });

  it('400s on a missing publicToken', async () => {
    const { POST } = await import('@/app/api/internal/channels/web/context/route');
    const res = await POST(makeRequest({}, { 'x-kairikos-internal-key': VALID_KEY }));
    expect(res.status).toBe(400);
  });

  it('404s when the publicToken does not match any ChatWebEmbed', async () => {
    mockState.embedFindUnique.mockResolvedValue(null);
    const { POST } = await import('@/app/api/internal/channels/web/context/route');
    const res = await POST(makeRequest({ publicToken: 'wgt_missing' }, { 'x-kairikos-internal-key': VALID_KEY }));
    expect(res.status).toBe(404);
  });

  it('403s when the embed is not active', async () => {
    mockState.embedFindUnique.mockResolvedValue({ clientId: 'c1', tenantId: null, status: 'disabled', primaryColor: '#000', position: 'bottom-right' });
    const { POST } = await import('@/app/api/internal/channels/web/context/route');
    const res = await POST(makeRequest({ publicToken: 'wgt_1' }, { 'x-kairikos-internal-key': VALID_KEY }));
    expect(res.status).toBe(403);
  });

  it('returns a safe default welcome message when no Paso 9 payload is active yet', async () => {
    mockState.embedFindUnique.mockResolvedValue({ clientId: 'c1', tenantId: 't1', status: 'active', primaryColor: '#0E6B5E', position: 'bottom-right' });
    mockState.stepFindFirst.mockResolvedValue(null);
    const { POST } = await import('@/app/api/internal/channels/web/context/route');
    const res = await POST(makeRequest({ publicToken: 'wgt_1' }, { 'x-kairikos-internal-key': VALID_KEY }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.businessName).toBe('Clínica Orly');
    expect(body.welcomeMessage).toContain('Hola');
    expect(body.suggestedPrompts).toEqual([]);
  });

  it('returns the active Paso 9 copy when present', async () => {
    mockState.embedFindUnique.mockResolvedValue({ clientId: 'c1', tenantId: 't1', status: 'active', primaryColor: '#FF0000', position: 'bottom-left' });
    mockState.stepFindFirst.mockResolvedValue({
      payload: { mensaje_bienvenida: '¡Bienvenido a Clínica Orly!', mensaje_despedida: 'Hasta pronto', prompts_sugeridos: ['Pide cita', 'Horarios'] },
    });
    const { POST } = await import('@/app/api/internal/channels/web/context/route');
    const res = await POST(makeRequest({ publicToken: 'wgt_1' }, { 'x-kairikos-internal-key': VALID_KEY }));
    const body = await res.json();
    expect(body.welcomeMessage).toBe('¡Bienvenido a Clínica Orly!');
    expect(body.farewellMessage).toBe('Hasta pronto');
    expect(body.suggestedPrompts).toEqual(['Pide cita', 'Horarios']);
    expect(body.primaryColor).toBe('#FF0000');
    expect(body.position).toBe('bottom-left');
  });

  it('queries the step scoped to activeForBot=true, not just the latest version', async () => {
    mockState.embedFindUnique.mockResolvedValue({ clientId: 'c1', tenantId: null, status: 'active', primaryColor: '#000', position: 'bottom-right' });
    const { POST } = await import('@/app/api/internal/channels/web/context/route');
    await POST(makeRequest({ publicToken: 'wgt_1' }, { 'x-kairikos-internal-key': VALID_KEY }));
    expect(mockState.stepFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ activeForBot: true, stepKey: '9' }) }),
    );
  });
});

describe('POST /api/internal/channels/web/message', () => {
  const activeEmbed = { clientId: 'c1', tenantId: 't1', status: 'active' };

  it('401s without a matching internal key', async () => {
    const { POST } = await import('@/app/api/internal/channels/web/message/route');
    const res = await POST(makeRequest({ publicToken: 'wgt_1', sessionId: 's1', role: 'user', content: 'hola' }));
    expect(res.status).toBe(401);
  });

  it('400s on an invalid role', async () => {
    const { POST } = await import('@/app/api/internal/channels/web/message/route');
    const res = await POST(
      makeRequest({ publicToken: 'wgt_1', sessionId: 's1', role: 'bot', content: 'hola' }, { 'x-kairikos-internal-key': VALID_KEY }),
    );
    expect(res.status).toBe(400);
  });

  it('404s when the publicToken does not match any ChatWebEmbed', async () => {
    mockState.embedFindUnique.mockResolvedValue(null);
    const { POST } = await import('@/app/api/internal/channels/web/message/route');
    const res = await POST(
      makeRequest({ publicToken: 'wgt_x', sessionId: 's1', role: 'user', content: 'hola' }, { 'x-kairikos-internal-key': VALID_KEY }),
    );
    expect(res.status).toBe(404);
  });

  it('creates a new conversation row on the first turn of a session', async () => {
    mockState.embedFindUnique.mockResolvedValue(activeEmbed);
    mockState.conversationFindUnique.mockResolvedValue(null);
    const { POST } = await import('@/app/api/internal/channels/web/message/route');
    const res = await POST(
      makeRequest({ publicToken: 'wgt_1', sessionId: 's1', role: 'user', content: '¿Abrís el sábado?' }, { 'x-kairikos-internal-key': VALID_KEY }),
    );
    expect(res.status).toBe(200);
    expect(mockState.conversationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          clientId: 'c1',
          tenantId: 't1',
          externalSessionId: 's1',
          transcript: [expect.objectContaining({ role: 'user', content: '¿Abrís el sábado?' })],
        }),
      }),
    );
    expect(mockState.conversationUpdate).not.toHaveBeenCalled();
  });

  it('appends to the existing transcript on a later turn, preserving prior messages', async () => {
    mockState.embedFindUnique.mockResolvedValue(activeEmbed);
    mockState.conversationFindUnique.mockResolvedValue({
      id: 'conv_1',
      startedAt: new Date(Date.now() - 5000),
      outcome: null,
      transcript: [{ role: 'user', content: '¿Abrís el sábado?', at: '2026-08-19T10:00:00.000Z' }],
    });
    const { POST } = await import('@/app/api/internal/channels/web/message/route');
    await POST(
      makeRequest(
        { publicToken: 'wgt_1', sessionId: 's1', role: 'assistant', content: 'Sí, de 10 a 14h.' },
        { 'x-kairikos-internal-key': VALID_KEY },
      ),
    );
    expect(mockState.conversationCreate).not.toHaveBeenCalled();
    const call = mockState.conversationUpdate.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'conv_1' });
    expect(call.data.transcript).toHaveLength(2);
    expect(call.data.transcript[1]).toEqual(expect.objectContaining({ role: 'assistant', content: 'Sí, de 10 a 14h.' }));
  });

  it('only overwrites outcome when the caller sends one, preserving the prior value otherwise', async () => {
    mockState.embedFindUnique.mockResolvedValue(activeEmbed);
    mockState.conversationFindUnique.mockResolvedValue({
      id: 'conv_1',
      startedAt: new Date(),
      outcome: 'resolved',
      transcript: [],
    });
    const { POST } = await import('@/app/api/internal/channels/web/message/route');
    await POST(
      makeRequest({ publicToken: 'wgt_1', sessionId: 's1', role: 'user', content: 'gracias' }, { 'x-kairikos-internal-key': VALID_KEY }),
    );
    expect(mockState.conversationUpdate.mock.calls[0][0].data.outcome).toBe('resolved');
  });

  it('overwrites outcome when the caller sends a new one', async () => {
    mockState.embedFindUnique.mockResolvedValue(activeEmbed);
    mockState.conversationFindUnique.mockResolvedValue({
      id: 'conv_1',
      startedAt: new Date(),
      outcome: null,
      transcript: [],
    });
    const { POST } = await import('@/app/api/internal/channels/web/message/route');
    await POST(
      makeRequest(
        { publicToken: 'wgt_1', sessionId: 's1', role: 'user', content: 'quiero hablar con alguien', outcome: 'escalated' },
        { 'x-kairikos-internal-key': VALID_KEY },
      ),
    );
    expect(mockState.conversationUpdate.mock.calls[0][0].data.outcome).toBe('escalated');
  });
});
