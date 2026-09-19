// =============================================================================
// Fase 1.2 — unit tests para POST /api/internal/channels/whatsapp/reply.
//
// Las otras cuatro rutas de canal son la misma plantilla cambiando cómo se
// resuelve la conexión; lo que se prueba aquí es el contrato HTTP que
// comparten todas: auth, resolución del cliente desde la plataforma (nunca
// del cuerpo) y los códigos de error que n8n tiene que saber distinguir.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  metaFindFirst: vi.fn(),
  replyToIncomingMessage: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    // Fase 4 multi-instancia — la ruta resuelve qué chatbot sirve el canal
    // (resolveChatbotForChannel), que pide hasta dos contrataciones para poder
    // detectar ambigüedad. Uno, como todos los clientes de hoy.
    clientProduct: {
      findMany: async () => [
        {
          id: '33333333-3333-4333-8333-333333333333',
          clientId: 'client_1',
          clientSiteId: null,
          tenantId: 'tenant_1',
          status: 'active',
          product: { code: 'chatbot', tier: 'starter' },
        },
      ],
    },
    metaChannelConnection: { findFirst: (...a: unknown[]) => mockState.metaFindFirst(...a) },
  },
}));

vi.mock('@/lib/chatbot-conversation', () => ({
  replyToIncomingMessage: (...a: unknown[]) => mockState.replyToIncomingMessage(...a),
}));

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return {
    json: async () => body,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

const VALID_KEY = 'test_portal_api_key';
const AUTH = { 'x-kairikos-internal-key': VALID_KEY };
const VALID_BODY = { phoneNumberId: 'phone_1', from: '34600111222', text: 'quiero pedir cita' };
const activeConnection = { id: 'conn_1', clientId: 'c1', tenantId: 't1', channel: 'whatsapp', status: 'active' };

async function post(body: unknown, headers = AUTH) {
  const { POST } = await import('@/app/api/internal/channels/whatsapp/reply/route');
  return POST(makeRequest(body, headers));
}

beforeEach(() => {
  process.env.PORTAL_API_KEY = VALID_KEY;
  mockState.isDatabaseConfigured = true;
  mockState.metaFindFirst.mockReset().mockResolvedValue(activeConnection);
  mockState.replyToIncomingMessage.mockReset().mockResolvedValue({
    ok: true, conversationId: 'conv_1', reply: '¿Qué día te viene bien?', escalate: false, escalateReason: null,
  });
});

afterEach(() => {
  delete process.env.PORTAL_API_KEY;
});

describe('POST /api/internal/channels/whatsapp/reply', () => {
  it('401 sin la clave interna', async () => {
    const res = await post(VALID_BODY, {});
    expect(res.status).toBe(401);
    expect(mockState.replyToIncomingMessage).not.toHaveBeenCalled();
  });

  it('400 con un cuerpo inválido', async () => {
    expect((await post({ phoneNumberId: 'phone_1' })).status).toBe(400);
  });

  it('404 cuando no hay conexión para ese número', async () => {
    mockState.metaFindFirst.mockResolvedValue(null);
    expect((await post(VALID_BODY)).status).toBe(404);
  });

  it('403 cuando la conexión está revocada', async () => {
    mockState.metaFindFirst.mockResolvedValue({ ...activeConnection, status: 'revoked' });
    expect((await post(VALID_BODY)).status).toBe(403);
  });

  it('resuelve el cliente desde el phone_number_id, nunca del cuerpo', async () => {
    await post({ ...VALID_BODY, clientId: 'otro_cliente' });
    expect(mockState.metaFindFirst).toHaveBeenCalledWith({ where: { channel: 'whatsapp', externalId: 'phone_1' } });
    expect(mockState.replyToIncomingMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ clientId: 'c1', tenantId: 't1', channel: 'whatsapp' }),
    );
  });

  it('agrupa la conversación por remitente, con el prefijo del canal', async () => {
    await post(VALID_BODY);
    expect(mockState.replyToIncomingMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ key: { kind: 'inactivity', sessionPrefix: 'whatsapp-34600111222-' } }),
    );
  });

  it('devuelve la respuesta lista para enviar', async () => {
    const res = await post(VALID_BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true, conversationId: 'conv_1', reply: '¿Qué día te viene bien?', escalate: false, escalateReason: null,
    });
  });

  it('propaga la derivación para que n8n pueda avisar a una persona', async () => {
    mockState.replyToIncomingMessage.mockResolvedValue({
      ok: true, conversationId: 'conv_1', reply: 'Te paso con el equipo.', escalate: true, escalateReason: 'tema prohibido',
    });
    const body = await (await post(VALID_BODY)).json();
    expect(body).toMatchObject({ escalate: true, escalateReason: 'tema prohibido' });
  });

  it('503 distinguible cuando falta la clave de IA, con la conversación ya registrada', async () => {
    mockState.replyToIncomingMessage.mockResolvedValue({ ok: true, skipped: true, reason: 'no_api_key', conversationId: 'conv_1' });
    const res = await post(VALID_BODY);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ detail: 'ai_not_configured', conversationId: 'conv_1' });
  });

  it('502 cuando el modelo falla — n8n no debe enviar nada al cliente', async () => {
    mockState.replyToIncomingMessage.mockResolvedValue({ ok: false, error: 'anthropic_api_error:529', conversationId: 'conv_1' });
    const res = await post(VALID_BODY);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'reply_failed', conversationId: 'conv_1' });
  });

  it('503 cuando no hay base de datos', async () => {
    mockState.isDatabaseConfigured = false;
    expect((await post(VALID_BODY)).status).toBe(503);
  });

  it('405 en GET', async () => {
    const { GET } = await import('@/app/api/internal/channels/whatsapp/reply/route');
    expect(GET().status).toBe(405);
  });
});
