// =============================================================================
// POST /api/public/channels/web/contact — el visitante deja por dónde
// localizarle cuando el bot deriva. Es la única forma de que en el chat de
// la web "te paso con alguien del equipo" signifique algo: por ahí no se
// puede contestar. Ver src/app/api/public/channels/web/contact/route.ts.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { WIDGET_CONTACT_NOTICE_VERSION } from '@/lib/web-widget-context';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  embedFindUnique: vi.fn(),
  conversationFindUnique: vi.fn(),
  conversationUpdate: vi.fn(),
  clientFindUnique: vi.fn(),
  sendWidgetContactEmail: vi.fn(),
  logError: vi.fn(),
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
vi.mock('@/lib/observability', () => ({ logError: (...a: unknown[]) => mockState.logError(...a) }));

const ACTIVE_EMBED = { clientId: 'c1', clientProductId: 'cp_1', tenantId: 't1', status: 'active' };
const CONVERSATION = {
  id: 'conv_1',
  clientProductId: 'cp_1',
  startedAt: new Date('2026-09-22T10:00:00.000Z'),
  transcript: [
    { role: 'user', content: '¿Hacéis urgencias los domingos?', at: '2026-09-22T10:00:00.000Z' },
    { role: 'assistant', content: 'Te paso con una persona del equipo.', at: '2026-09-22T10:00:05.000Z' },
  ],
};

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return { json: async () => body, headers: new Headers(headers) } as unknown as NextRequest;
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
  mockState.logError.mockReset();
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

// Dominios permitidos (16/11/2026) — ver lib/web-widget-origin.ts.
describe('POST /api/public/channels/web/contact — dominios permitidos', () => {
  const conLista = { ...ACTIVE_EMBED, allowedOrigins: ['https://www.clinica.example'] };

  it('lista vacía: guarda el contacto venga de donde venga', async () => {
    mockState.embedFindUnique.mockResolvedValue({ ...ACTIVE_EMBED, allowedOrigins: [] });
    const { POST } = await import('@/app/api/public/channels/web/contact/route');
    const res = await POST(makeRequest(validBody(), { origin: 'https://otra.example' }));
    expect(res.status).toBe(200);
  });

  it('origen en la lista: guarda el contacto', async () => {
    mockState.embedFindUnique.mockResolvedValue(conLista);
    const { POST } = await import('@/app/api/public/channels/web/contact/route');
    const res = await POST(makeRequest(validBody(), { origin: 'https://www.clinica.example' }));
    expect(res.status).toBe(200);
    expect(mockState.conversationUpdate).toHaveBeenCalled();
  });

  it('origen fuera de la lista: 404 como un widget apagado, con CORS, sin tocar nada', async () => {
    mockState.embedFindUnique.mockResolvedValue(conLista);
    const { POST } = await import('@/app/api/public/channels/web/contact/route');
    const res = await POST(makeRequest(validBody(), { origin: 'https://copion.example' }));
    expect(res.status).toBe(404);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(mockState.conversationUpdate).not.toHaveBeenCalled();
    expect(mockState.sendWidgetContactEmail).not.toHaveBeenCalled();
  });

  it('sin cabecera Origin, con lista: 404', async () => {
    mockState.embedFindUnique.mockResolvedValue(conLista);
    const { POST } = await import('@/app/api/public/channels/web/contact/route');
    const res = await POST(makeRequest(validBody()));
    expect(res.status).toBe(404);
  });

  // 21/11/2026 — con 5/min por widget contados antes de mirar la web, una web
  // fuera de la lista dejaba sin formulario a las buenas en cinco peticiones.
  it('una web fuera de la lista no gasta el cupo del widget', async () => {
    mockState.embedFindUnique.mockResolvedValue(conLista);
    const { POST } = await import('@/app/api/public/channels/web/contact/route');
    const body = validBody({ publicToken: 'wgt_copion_' + Math.random().toString(36).slice(2) });
    for (let i = 0; i < 8; i += 1) {
      expect((await POST(makeRequest(body, { origin: 'https://copion.example' }))).status).toBe(404);
    }
    expect((await POST(makeRequest(body, { origin: 'https://www.clinica.example' }))).status).toBe(200);
  });

  // ===========================================================================
  // Consentimiento (25/11/2026, plan del encargo del tratamiento, PR 3).
  // ===========================================================================

  describe('consentimiento', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-22T10:03:20.000Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('con versión y casilla, guarda la fecha y la versión en la conversación', async () => {
      const { POST } = await import('@/app/api/public/channels/web/contact/route');
      const res = await POST(makeRequest(validBody({ consent: true, noticeVersion: WIDGET_CONTACT_NOTICE_VERSION })));
      expect(res.status).toBe(200);
      const data = mockState.conversationUpdate.mock.calls[0][0].data;
      expect(data.contactConsentAt).toEqual(new Date('2026-09-22T10:03:20.000Z'));
      expect(data.contactNoticeVersion).toBe('2026-12-v1');
      expect(mockState.logError).not.toHaveBeenCalled();
    });

    it('con versión y SIN casilla: 400 consent_required, sin tocar la conversación', async () => {
      const { POST } = await import('@/app/api/public/channels/web/contact/route');
      for (const consent of [false, undefined]) {
        const res = await POST(makeRequest(validBody({ consent, noticeVersion: WIDGET_CONTACT_NOTICE_VERSION })));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ success: false, error: 'consent_required' });
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      }
      expect(mockState.conversationUpdate).not.toHaveBeenCalled();
      expect(mockState.sendWidgetContactEmail).not.toHaveBeenCalled();
    });

    it('una versión que no existe es un 400 como cualquier campo mal', async () => {
      const { POST } = await import('@/app/api/public/channels/web/contact/route');
      const res = await POST(makeRequest(validBody({ consent: true, noticeVersion: '2099-01-v9' })));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ success: false, error: 'bad_request' });
      expect(mockState.conversationUpdate).not.toHaveBeenCalled();
    });

    it('sin versión (v1 o pestaña antigua): se acepta, columnas sin tocar (NULL) y se cuenta', async () => {
      const { POST } = await import('@/app/api/public/channels/web/contact/route');
      const res = await POST(makeRequest(validBody()));
      expect(res.status).toBe(200);
      const data = mockState.conversationUpdate.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('contactConsentAt');
      expect(data).not.toHaveProperty('contactNoticeVersion');
      expect(mockState.logError).toHaveBeenCalledWith(
        'widget_contact.legacy_no_consent',
        expect.any(Error),
        { conversationId: 'conv_1' },
        'warn',
      );
    });

    it('sin enlace a la política (privacyLinkShown: false): se guarda y se registra el aviso', async () => {
      const { POST } = await import('@/app/api/public/channels/web/contact/route');
      const res = await POST(
        makeRequest(validBody({ consent: true, noticeVersion: WIDGET_CONTACT_NOTICE_VERSION, privacyLinkShown: false })),
      );
      expect(res.status).toBe(200);
      expect(mockState.conversationUpdate.mock.calls[0][0].data.contactNoticeVersion).toBe('2026-12-v1');
      expect(mockState.logError).toHaveBeenCalledWith(
        'widget.privacy_url_missing',
        expect.any(Error),
        { conversationId: 'conv_1', clientId: 'c1' },
        'warn',
      );
    });

    it('actualiza la duración de la conversación hasta este turno', async () => {
      const { POST } = await import('@/app/api/public/channels/web/contact/route');
      await POST(makeRequest(validBody({ consent: true, noticeVersion: WIDGET_CONTACT_NOTICE_VERSION })));
      // startedAt 10:00:00, ahora 10:03:20.
      expect(mockState.conversationUpdate.mock.calls[0][0].data.duration).toBe(200);
    });

    it('también actualiza la duración en los envíos sin versión', async () => {
      const { POST } = await import('@/app/api/public/channels/web/contact/route');
      await POST(makeRequest(validBody()));
      expect(mockState.conversationUpdate.mock.calls[0][0].data.duration).toBe(200);
    });
  });
});
