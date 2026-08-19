// =============================================================================
// Canales Fase 4 — unit tests for GET /api/public/channels/web/config.
// Genuinely public (no internal-auth, no portal session) — called
// cross-origin from the widget running on a THIRD-PARTY site, so these
// tests focus on: never leaking anything beyond display copy, CORS
// headers on every response (including errors), and status/token gates.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  embedFindUnique: vi.fn(),
  clientFindUnique: vi.fn(),
  stepFindFirst: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    chatWebEmbed: { findUnique: (...args: unknown[]) => mockState.embedFindUnique(...args) },
    chatbotClient: { findUnique: (...args: unknown[]) => mockState.clientFindUnique(...args) },
    chatbotConfigStep: { findFirst: (...args: unknown[]) => mockState.stepFindFirst(...args) },
  },
}));

function makeRequest(token: string | null): NextRequest {
  const url = new URL('https://portal.kairikos.com/api/public/channels/web/config');
  if (token !== null) url.searchParams.set('token', token);
  return { nextUrl: url } as unknown as NextRequest;
}

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.embedFindUnique.mockReset();
  mockState.clientFindUnique.mockReset().mockResolvedValue({ companyName: 'Clínica Orly', name: 'Orly' });
  mockState.stepFindFirst.mockReset().mockResolvedValue(null);
  delete process.env.N8N_WEBCHAT_URL;
});

describe('GET /api/public/channels/web/config', () => {
  it('400s without a token, with CORS headers', async () => {
    const { GET } = await import('@/app/api/public/channels/web/config/route');
    const res = await GET(makeRequest(null));
    expect(res.status).toBe(400);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('404s when the token does not match any embed', async () => {
    mockState.embedFindUnique.mockResolvedValue(null);
    const { GET } = await import('@/app/api/public/channels/web/config/route');
    const res = await GET(makeRequest('wgt_missing'));
    expect(res.status).toBe(404);
  });

  it('404s when the embed exists but is disabled', async () => {
    mockState.embedFindUnique.mockResolvedValue({ clientId: 'c1', status: 'disabled', primaryColor: '#000', position: 'bottom-right' });
    const { GET } = await import('@/app/api/public/channels/web/config/route');
    const res = await GET(makeRequest('wgt_1'));
    expect(res.status).toBe(404);
  });

  it('returns only display copy — never anything resembling an internal id or secret', async () => {
    mockState.embedFindUnique.mockResolvedValue({ clientId: 'c1', status: 'active', primaryColor: '#0E6B5E', position: 'bottom-right' });
    process.env.N8N_WEBCHAT_URL = 'https://n8n.example.com/webhook/kairikos-webchat-multitenant';
    const { GET } = await import('@/app/api/public/channels/web/config/route');
    const res = await GET(makeRequest('wgt_1'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(body).toEqual({
      businessName: 'Clínica Orly',
      welcomeMessage: '¡Hola! ¿En qué puedo ayudarte?',
      farewellMessage: null,
      suggestedPrompts: [],
      primaryColor: '#0E6B5E',
      position: 'bottom-right',
      chatEndpoint: 'https://n8n.example.com/webhook/kairikos-webchat-multitenant',
    });
    expect(body.clientId).toBeUndefined();
    expect(body.publicToken).toBeUndefined();
  });

  it('uses the operator-approved (activeForBot) Paso 9 copy when present', async () => {
    mockState.embedFindUnique.mockResolvedValue({ clientId: 'c1', status: 'active', primaryColor: '#FF0000', position: 'bottom-left' });
    mockState.stepFindFirst.mockResolvedValue({
      payload: { mensaje_bienvenida: 'Hola, bienvenido', mensaje_despedida: 'Gracias por escribir', prompts_sugeridos: ['Precios', 'Horarios'] },
    });
    const { GET } = await import('@/app/api/public/channels/web/config/route');
    const res = await GET(makeRequest('wgt_1'));
    const body = await res.json();
    expect(body.welcomeMessage).toBe('Hola, bienvenido');
    expect(body.farewellMessage).toBe('Gracias por escribir');
    expect(body.suggestedPrompts).toEqual(['Precios', 'Horarios']);
  });

  it('returns chatEndpoint=null when N8N_WEBCHAT_URL is not configured', async () => {
    mockState.embedFindUnique.mockResolvedValue({ clientId: 'c1', status: 'active', primaryColor: '#000', position: 'bottom-right' });
    const { GET } = await import('@/app/api/public/channels/web/config/route');
    const res = await GET(makeRequest('wgt_1'));
    const body = await res.json();
    expect(body.chatEndpoint).toBeNull();
  });

  it('503s when the database is not configured', async () => {
    mockState.isDatabaseConfigured = false;
    const { GET } = await import('@/app/api/public/channels/web/config/route');
    const res = await GET(makeRequest('wgt_1'));
    expect(res.status).toBe(503);
    expect(mockState.embedFindUnique).not.toHaveBeenCalled();
  });
});
