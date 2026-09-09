// =============================================================================
// Fase 3 — unit tests para src/lib/chatbot-handoff.ts.
//
// Lo que se fija aquí:
//
//   • parseRecipient. Es de donde sale a QUIÉN se contesta. Equivocarse no
//     da error: manda el mensaje del negocio a otra persona.
//   • botShouldReply. La regla que justifica toda la bandeja: mientras un
//     humano la tiene, el bot se calla. Y su contraria, igual de
//     importante: mientras solo está pendiente, el bot sigue, para no
//     dejar al cliente final hablando solo.
//   • Que se envíe ANTES de guardar el turno, para que un fallo de la
//     plataforma no deje en el historial un mensaje que nadie recibió.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const mockState = vi.hoisted(() => ({
  logError: vi.fn(),
  decryptMetaToken: vi.fn(),
  decryptChannelCredential: vi.fn(),
  sendWhatsapp: vi.fn(),
  sendTelegram: vi.fn(),
  sendMessenger: vi.fn(),
  sendInstagram: vi.fn(),
}));

vi.mock('@/lib/observability', () => ({ logError: (...a: unknown[]) => mockState.logError(...a) }));
vi.mock('@/lib/meta-business', () => ({ decryptMetaToken: (...a: unknown[]) => mockState.decryptMetaToken(...a) }));
vi.mock('@/lib/channel-crypto', () => ({
  decryptChannelCredential: (...a: unknown[]) => mockState.decryptChannelCredential(...a),
}));
vi.mock('@/lib/whatsapp-api', () => ({ sendMessage: (...a: unknown[]) => mockState.sendWhatsapp(...a) }));
vi.mock('@/lib/telegram-api', () => ({ sendMessage: (...a: unknown[]) => mockState.sendTelegram(...a) }));
vi.mock('@/lib/messenger-api', () => ({ sendMessage: (...a: unknown[]) => mockState.sendMessenger(...a) }));
vi.mock('@/lib/instagram-api', () => ({ sendMessage: (...a: unknown[]) => mockState.sendInstagram(...a) }));

import {
  parseRecipient,
  handoffState,
  botShouldReply,
  isHandoffChannel,
  sendAgentMessage,
} from '@/lib/chatbot-handoff';

describe('parseRecipient', () => {
  it('saca el número de WhatsApp del id de sesión', () => {
    expect(parseRecipient('whatsapp', 'whatsapp-34600111222-1789000000000')).toBe('34600111222');
  });

  it('vale para los cuatro canales', () => {
    expect(parseRecipient('telegram', 'telegram-987654321-1789000000000')).toBe('987654321');
    expect(parseRecipient('messenger', 'messenger-PSID_ABC-1789000000000')).toBe('PSID_ABC');
    expect(parseRecipient('instagram', 'instagram-17841400000-1789000000000')).toBe('17841400000');
  });

  it('conserva los guiones que van dentro del identificador', () => {
    expect(parseRecipient('messenger', 'messenger-a-b-c-1789000000000')).toBe('a-b-c');
  });

  it('no adivina cuando el id no lo generamos nosotros', () => {
    // Un id de sesión del widget web: no lleva el timestamp al final.
    expect(parseRecipient('web', 'sesion-aleatoria-del-widget')).toBeNull();
    expect(parseRecipient('whatsapp', 'telegram-123-1789000000000')).toBeNull();
    expect(parseRecipient('whatsapp', 'whatsapp-34600111222')).toBeNull();
    expect(parseRecipient('whatsapp', null)).toBeNull();
  });

  it('sin identificador no devuelve una cadena vacía, devuelve null', () => {
    expect(parseRecipient('whatsapp', 'whatsapp--1789000000000')).toBeNull();
  });
});

describe('isHandoffChannel', () => {
  it('los cuatro canales con API saliente', () => {
    for (const c of ['whatsapp', 'telegram', 'messenger', 'instagram']) {
      expect(isHandoffChannel(c)).toBe(true);
    }
  });

  it('el widget web no admite respuesta: es una página que ya se cerró', () => {
    expect(isHandoffChannel('web')).toBe(false);
    expect(isHandoffChannel(null)).toBe(false);
  });
});

describe('handoffState / botShouldReply', () => {
  const d = new Date('2026-09-20T10:00:00Z');

  it('una conversación normal no está en traspaso y el bot responde', () => {
    const row = { handoffRequestedAt: null, handoffTakenAt: null, handoffClosedAt: null };
    expect(handoffState(row)).toBe('none');
    expect(botShouldReply(row)).toBe(true);
  });

  it('pendiente: el bot SIGUE respondiendo, para no dejar al cliente hablando solo', () => {
    const row = { handoffRequestedAt: d, handoffTakenAt: null, handoffClosedAt: null };
    expect(handoffState(row)).toBe('pending');
    expect(botShouldReply(row)).toBe(true);
  });

  it('tomada por una persona: el bot se calla', () => {
    const row = { handoffRequestedAt: d, handoffTakenAt: d, handoffClosedAt: null };
    expect(handoffState(row)).toBe('taken');
    expect(botShouldReply(row)).toBe(false);
  });

  it('devuelta al bot: vuelve a responder', () => {
    const row = { handoffRequestedAt: d, handoffTakenAt: null, handoffClosedAt: d };
    expect(handoffState(row)).toBe('closed');
    expect(botShouldReply(row)).toBe(true);
  });

  it('una fila sin estas columnas se lee como "sin traspaso", nunca como bot mudo', () => {
    expect(handoffState({})).toBe('none');
    expect(botShouldReply({})).toBe(true);
  });
});

describe('sendAgentMessage', () => {
  const state = {
    conversationFindFirst: vi.fn(),
    conversationUpdate: vi.fn(),
    metaFindFirst: vi.fn(),
    telegramFindFirst: vi.fn(),
  };

  const prisma = {
    chatbotConversation: {
      findFirst: (...a: unknown[]) => state.conversationFindFirst(...a),
      update: (...a: unknown[]) => state.conversationUpdate(...a),
    },
    metaChannelConnection: { findFirst: (...a: unknown[]) => state.metaFindFirst(...a) },
    telegramConnection: { findFirst: (...a: unknown[]) => state.telegramFindFirst(...a) },
  } as unknown as PrismaClient;

  const NOW = new Date('2026-09-20T12:00:00.000Z');

  const conversation = {
    id: 'conv_1',
    clientId: 'c1',
    channel: 'whatsapp',
    externalSessionId: 'whatsapp-34600111222-1789000000000',
    startedAt: new Date('2026-09-20T11:00:00.000Z'),
    transcript: [{ role: 'user', content: 'Quiero hablar con alguien', at: '2026-09-20T11:00:00.000Z' }],
  };

  const input = {
    conversationId: 'conv_1',
    clientId: 'c1',
    text: 'Hola, soy Marta. Te ayudo yo.',
    agentEmail: 'marta@aurora.example',
    now: NOW,
  };

  beforeEach(() => {
    for (const fn of Object.values(state)) fn.mockReset();
    for (const fn of Object.values(mockState)) fn.mockReset();
    state.conversationFindFirst.mockResolvedValue(conversation);
    state.conversationUpdate.mockResolvedValue({});
    state.metaFindFirst.mockResolvedValue({
      externalId: 'phone_id_1',
      accessTokenCiphertext: Buffer.from(''),
      accessTokenIv: Buffer.from(''),
      accessTokenTag: Buffer.from(''),
    });
    mockState.decryptMetaToken.mockReturnValue('tok');
    mockState.sendWhatsapp.mockResolvedValue({ ok: true, data: {} });
  });

  it('envía por el canal correcto, al destinatario sacado del id de sesión', async () => {
    expect(await sendAgentMessage(prisma, input)).toEqual({ ok: true });
    expect(mockState.sendWhatsapp).toHaveBeenCalledWith('tok', 'phone_id_1', '34600111222', input.text);
  });

  it('deja el turno en el transcript marcado como del equipo, no del bot', async () => {
    await sendAgentMessage(prisma, input);
    const entries = state.conversationUpdate.mock.calls[0][0].data.transcript;
    expect(entries).toHaveLength(2);
    expect(entries[1]).toEqual({
      // 'assistant' porque para el cliente final es la misma voz del
      // negocio; `by` es lo que distingue quién escribió.
      role: 'assistant',
      content: input.text,
      at: NOW.toISOString(),
      by: 'agent',
      agentEmail: 'marta@aurora.example',
    });
  });

  it('si la plataforma rechaza el envío, NO se guarda el turno', async () => {
    mockState.sendWhatsapp.mockResolvedValue({ ok: false, error: '(#131047) re-engagement required' });

    const result = await sendAgentMessage(prisma, input);

    expect(result).toMatchObject({ ok: false, error: 'send_failed' });
    // Lo importante: nadie recibió el mensaje, así que no puede aparecer
    // en el historial como si sí.
    expect(state.conversationUpdate).not.toHaveBeenCalled();
  });

  it('el canal web se rechaza antes de buscar ninguna conexión', async () => {
    state.conversationFindFirst.mockResolvedValue({ ...conversation, channel: 'web', externalSessionId: 'abc123' });
    expect(await sendAgentMessage(prisma, input)).toEqual({ ok: false, error: 'channel_not_supported' });
    expect(state.metaFindFirst).not.toHaveBeenCalled();
  });

  it('sin conexión activa no se inventa un envío', async () => {
    state.metaFindFirst.mockResolvedValue(null);
    expect(await sendAgentMessage(prisma, input)).toEqual({ ok: false, error: 'no_connection' });
    expect(mockState.sendWhatsapp).not.toHaveBeenCalled();
  });

  it('una conversación de otra empresa simplemente no existe', async () => {
    state.conversationFindFirst.mockResolvedValue(null);
    expect(await sendAgentMessage(prisma, input)).toEqual({ ok: false, error: 'conversation_not_found' });
    // El clientId va DENTRO de la consulta, no se comprueba después.
    expect(state.conversationFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'conv_1', clientId: 'c1' } }),
    );
  });

  it('telegram usa su propia conexión y su propia clave de cifrado', async () => {
    state.conversationFindFirst.mockResolvedValue({
      ...conversation,
      channel: 'telegram',
      externalSessionId: 'telegram-987654321-1789000000000',
    });
    state.telegramFindFirst.mockResolvedValue({
      botTokenCiphertext: Buffer.from(''),
      botTokenIv: Buffer.from(''),
      botTokenTag: Buffer.from(''),
    });
    mockState.decryptChannelCredential.mockReturnValue('bot_token');
    mockState.sendTelegram.mockResolvedValue({ ok: true, data: {} });

    expect(await sendAgentMessage(prisma, input)).toEqual({ ok: true });
    expect(mockState.sendTelegram).toHaveBeenCalledWith('bot_token', '987654321', input.text);
    expect(mockState.decryptMetaToken).not.toHaveBeenCalled();
  });

  it('un fallo inesperado no se propaga como excepción', async () => {
    mockState.sendWhatsapp.mockRejectedValue(new Error('network down'));
    const result = await sendAgentMessage(prisma, input);
    expect(result).toMatchObject({ ok: false, error: 'send_failed' });
    expect(mockState.logError).toHaveBeenCalled();
  });
});
