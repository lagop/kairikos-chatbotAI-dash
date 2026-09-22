// =============================================================================
// POST /api/public/channels/web/contact — el visitante deja por dónde
// localizarle cuando el bot deriva. Es la única forma de que en el chat de
// la web "te paso con alguien del equipo" signifique algo: por ahí no se
// puede contestar. Ver src/app/api/public/channels/web/contact/route.ts.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  embedFindUnique: vi.fn(),
  conversationFindUnique: vi.fn(),
  conversationUpdate: vi.fn(),
  clientFindUnique: vi.fn(),
  sendWidgetContactEmail: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    chatWebEmbed: { findUnique: (...a: unknown[]) => mockState.embedFindUnique(...a) },
    chatbotConversation: {
      findUnique: (...a: unknown[]) => mockState.conversationFindUnique(...a),
      update: (...a: unknown[]) => mockState.conversationUpdate(...a),
    },
    chatbotClient: { findUnique: (...a: unknown[]) => mockState.clientFindUnique(...a) },
  },
}));

vi.mock('@/lib/chatbot-config', () => ({
  buildChatbotContext: vi.fn().mockResolvedValue({ businessName: 'Clínica Orly' }),
}));
vi.mock('@/lib/client-product-access', () => ({
  resolveChatbotForChannel: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/handoff-alert-email', () => ({
  sendWidgetContactEmail: (...a: unknown[]) => mockState.sendWidgetContactEmail(...a),
}));
vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));

const ACTIVE_EMBED = { clientId: 'c1', clientProductId: 'cp_1', tenantId: 't1', status: 'active' };
const CONVERSATION = {
  id: 'conv_1',
  clientProductId: 'cp_1',
  transcript: [
    { role: 'user', content: '¿Hacéis urgencias los domingos?', at: '2026-09-22T10:00:00.000Z' },
    { role: 'assistant', content: 'Te paso con una persona del equipo.', at: '2026-09-22T10:00:05.000Z' },
  ],
};

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

function validBody(extra: Record<string, unknown> = {}) {
  // Un publicToken distinto por test: el límite de peticiones se cuenta
  // por token y vive en memoria entre tests.
  return {
    publicToken: `wgt_${Math.random().toString(36).slice(2)}`,
    sessionId: 'web-abc123',
    name: 'Marta',
    contact: 'marta@example.com',
    ...extra,
  };
}

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.embedFindUnique.mockReset().mockResolvedValue(ACTIVE_EMBED);
  mockState.conversationFindUnique.mockReset().mockResolvedValue(CONVERSATION);
  mockState.conversationUpdate.mockReset().mockResolvedValue({});
  mockState.clientFindUnique.mockReset().mockResolvedValue({ email: 'duena@clinica.example' });
  mockState.sendWidgetContactEmail.mockReset().mockResolvedValue({ ok: true, messageId: 'm1' });
});

describe('POST /api/public/channels/web/contact', () => {
  it('guarda el contacto como un turno más del visitante y avisa al negocio', async () => {
    const { POST } = await import('@/app/api/public/channels/web/contact/route');
    const res = await POST(makeRequest(validBody()));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    const written = mockState.conversationUpdate.mock.calls[0][0].data.transcript;
    expect(written).toHaveLength(3);
    expect(written[2]).toMatchObject({ role: 'user', content: 'Mis datos de contacto: Marta — marta@example.com' });

    expect(mockState.sendWidgetContactEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'duena@clinica.example',
        businessName: 'Clínica Orly',
        conversationId: 'conv_1',
        visitorName: 'Marta',
        contact: 'marta@example.com',
        lastMessage: '¿Hacéis urgencias los domingos?',
      }),
    );
  });

  it('acepta un teléfono y aguanta sin nombre', async () => {
    const { POST } = await import('@/app/api/public/channels/web/contact/route');
    const res = await POST(makeRequest(validBody({ name: '', contact: '+34 600 11 22 33' })));

    expect(res.status).toBe(200);
    const written = mockState.conversationUpdate.mock.calls[0][0].data.transcript;
    expect(written[2].content).toBe('Mis datos de contacto: +34 600 11 22 33');
    expect(mockState.sendWidgetContactEmail.mock.calls[0][0].visitorName).toBeNull();
  });

  it('rechaza algo que no es ni teléfono ni correo, sin tocar la conversación', async () => {
    const { POST } = await import('@/app/api/public/channels/web/contact/route');
    const res = await POST(makeRequest(validBody({ contact: 'llámame' })));

    expect(res.status).toBe(400);
    expect(mockState.conversationUpdate).not.toHaveBeenCalled();
  });

  // El sessionId lo elige el navegador del visitante. El de otro canal
  // daría acceso a conversaciones de WhatsApp del negocio.
  it('rechaza un sessionId con la forma de otro canal', async () => {
    const { POST } = await import('@/app/api/public/channels/web/contact/route');
    const res = await POST(makeRequest(validBody({ sessionId: 'whatsapp-34600123456-1758000000000' })));

    expect(res.status).toBe(400);
    expect(mockState.conversationUpdate).not.toHaveBeenCalled();
  });

  it('busca la conversación por cliente y sesión, nunca solo por sesión', async () => {
    const { POST } = await import('@/app/api/public/channels/web/contact/route');
    await POST(makeRequest(validBody({ sessionId: 'web-abc123' })));

    expect(mockState.conversationFindUnique.mock.calls[0][0].where).toEqual({
      clientId_externalSessionId: { clientId: 'c1', externalSessionId: 'web-abc123' },
    });
  });

  it('404 con el widget apagado, sin decir si el token existe', async () => {
    mockState.embedFindUnique.mockResolvedValue({ ...ACTIVE_EMBED, status: 'disabled' });
    const { POST } = await import('@/app/api/public/channels/web/contact/route');
    const res = await POST(makeRequest(validBody()));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ success: false, error: 'not_available' });
  });

  it('404 cuando esa sesión no tiene conversación', async () => {
    mockState.conversationFindUnique.mockResolvedValue(null);
    const { POST } = await import('@/app/api/public/channels/web/contact/route');
    const res = await POST(makeRequest(validBody()));

    expect(res.status).toBe(404);
    expect(mockState.conversationUpdate).not.toHaveBeenCalled();
  });

  // Lo importante es no perder el dato: el email es el aviso, no el
  // registro.
  it('un email que falla no pierde el contacto', async () => {
    mockState.sendWidgetContactEmail.mockRejectedValue(new Error('resend caído'));
    const { POST } = await import('@/app/api/public/channels/web/contact/route');
    const res = await POST(makeRequest(validBody()));

    expect(res.status).toBe(200);
    expect(mockState.conversationUpdate).toHaveBeenCalled();
  });

  it('corta al sexto intento en un minuto con el mismo widget', async () => {
    const { POST } = await import('@/app/api/public/channels/web/contact/route');
    const token = 'wgt_limite';
    const results = [];
    for (let i = 0; i < 6; i += 1) {
      results.push(await POST(makeRequest(validBody({ publicToken: token }))));
    }
    expect(results.slice(0, 5).every((r) => r.status === 200)).toBe(true);
    expect(results[5].status).toBe(429);
  });

  it('responde con CORS abierto: corre en la web de un cliente', async () => {
    const { POST, OPTIONS } = await import('@/app/api/public/channels/web/contact/route');
    const res = await POST(makeRequest(validBody()));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect((await OPTIONS()).status).toBe(204);
  });
});
