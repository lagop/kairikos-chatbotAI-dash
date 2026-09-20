// =============================================================================
// Fase 2b — unit tests para POST /api/public/channels/web/message.
//
// Genuinely public (sin internal-auth, sin sesión): lo llama el navegador
// de un visitante anónimo en la web de un cliente. El contrato de salida
// tiene que seguir siendo EXACTAMENTE el que embed.js ya espera
// ({ success, data: { reply, sessionId, mode, ... } }), porque el widget
// publicado no cambia con esta migración.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  embedFindUnique: vi.fn(),
  replyToIncomingMessage: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    chatWebEmbed: { findUnique: (...a: unknown[]) => mockState.embedFindUnique(...a) },
    // resolveChatbotForChannel: un chatbot, como todos los clientes de hoy.
    clientProduct: {
      findMany: async () => [
        { id: 'cp_web', clientId: 'c1', clientSiteId: null, tenantId: 't1', status: 'active', product: { code: 'chatbot', tier: 'starter' } },
      ],
    },
  },
}));

vi.mock('@/lib/chatbot-conversation', () => ({
  replyToIncomingMessage: (...a: unknown[]) => mockState.replyToIncomingMessage(...a),
}));

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

const VALID_BODY = { publicToken: 'wgt_1', sessionId: 'web-abc123', message: 'hola' };
const activeEmbed = { clientId: 'c1', clientProductId: null, tenantId: 't1', status: 'active' };

async function post(body: unknown) {
  const { POST } = await import('@/app/api/public/channels/web/message/route');
  return POST(makeRequest(body));
}

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.embedFindUnique.mockReset().mockResolvedValue(activeEmbed);
  mockState.replyToIncomingMessage.mockReset().mockResolvedValue({
    ok: true, conversationId: 'conv_1', reply: 'Claro, ¿en qué te ayudo?', escalate: false, escalateReason: null,
  });
});

describe('POST /api/public/channels/web/message', () => {
  it('400 con un cuerpo inválido, con CORS', async () => {
    const res = await post({ publicToken: 'wgt_1' });
    expect(res.status).toBe(400);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('resuelve el widget por publicToken, nunca por un clientId del cuerpo', async () => {
    await post({ ...VALID_BODY, clientId: 'otro_cliente' });
    expect(mockState.embedFindUnique).toHaveBeenCalledWith({ where: { publicToken: 'wgt_1' } });
    expect(mockState.replyToIncomingMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ clientId: 'c1', tenantId: 't1', channel: 'web' }),
    );
  });

  it('agrupa la conversación por el sessionId exacto del navegador, no por inactividad', async () => {
    await post(VALID_BODY);
    expect(mockState.replyToIncomingMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ key: { kind: 'exact', externalSessionId: 'web-abc123' } }),
    );
  });

  it('token desconocido o widget apagado: mismo contrato que "widget no disponible", sin distinguir el motivo', async () => {
    mockState.embedFindUnique.mockResolvedValue(null);
    const res = await post(VALID_BODY);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({
      success: false,
      data: {
        sessionId: 'web-abc123',
        reply: 'Este chat no está disponible en este momento.',
        timestamp: expect.any(String),
        mode: 'unavailable',
        contactIntent: false,
        error: 'context_lookup_failed',
      },
    });
  });

  it('widget desactivado: mismo resultado que token desconocido', async () => {
    mockState.embedFindUnique.mockResolvedValue({ ...activeEmbed, status: 'disabled' });
    const body = await (await post(VALID_BODY)).json();
    expect(body.data.mode).toBe('unavailable');
  });

  it('respuesta normal del motor: mode "portal", el texto tal cual', async () => {
    const body = await (await post(VALID_BODY)).json();
    expect(body).toEqual({
      success: true,
      data: {
        sessionId: 'web-abc123',
        reply: 'Claro, ¿en qué te ayudo?',
        timestamp: expect.any(String),
        mode: 'portal',
        contactIntent: false,
        error: null,
      },
    });
  });

  it('traspaso a humano: mode "human", reply nunca null — el widget no sabe pintar null', async () => {
    mockState.replyToIncomingMessage.mockResolvedValue({ ok: true, skipped: true, reason: 'human_handoff', conversationId: 'conv_1' });
    const body = await (await post(VALID_BODY)).json();
    expect(body.data.mode).toBe('human');
    expect(typeof body.data.reply).toBe('string');
  });

  it('tope de gasto agotado: mode "cap"', async () => {
    mockState.replyToIncomingMessage.mockResolvedValue({ ok: true, skipped: true, reason: 'monthly_cap_reached', conversationId: 'conv_1' });
    const body = await (await post(VALID_BODY)).json();
    expect(body.data.mode).toBe('cap');
  });

  it('sin clave de IA: mode "fallback", detecta intención de contacto para variar el texto', async () => {
    mockState.replyToIncomingMessage.mockResolvedValue({ ok: true, skipped: true, reason: 'no_api_key', conversationId: 'conv_1' });
    const body = await (await post({ ...VALID_BODY, message: 'quiero pedir presupuesto' })).json();
    expect(body.data.mode).toBe('fallback');
    expect(body.data.contactIntent).toBe(true);
    expect(body.data.reply).toMatch(/nombre y un email o teléfono/);
  });

  it('el motor falla: mode "fallback" igualmente, nunca un 5xx que rompa el widget', async () => {
    mockState.replyToIncomingMessage.mockResolvedValue({ ok: false, error: 'anthropic_api_error:529', conversationId: 'conv_1' });
    const res = await post(VALID_BODY);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.mode).toBe('fallback');
    expect(body.data.error).toBe('anthropic_api_error:529');
  });

  it('503 cuando no hay base de datos', async () => {
    mockState.isDatabaseConfigured = false;
    const res = await post(VALID_BODY);
    expect(res.status).toBe(503);
    expect(mockState.embedFindUnique).not.toHaveBeenCalled();
  });

  it('freno de peticiones: se agota antes de 200 mensajes seguidos del mismo token', async () => {
    let sawTooMany = false;
    for (let i = 0; i < 200; i++) {
      const res = await post({ ...VALID_BODY, sessionId: `web-burst-${i}` });
      if (res.status === 429) {
        sawTooMany = true;
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
        break;
      }
    }
    expect(sawTooMany).toBe(true);
  });

  it('405 en GET', async () => {
    const { GET } = await import('@/app/api/public/channels/web/message/route');
    expect(GET().status).toBe(405);
  });
});
