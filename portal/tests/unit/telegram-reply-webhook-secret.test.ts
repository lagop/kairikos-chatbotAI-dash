// =============================================================================
// Revisión de seguridad del 22/09/2026 — POST /api/internal/channels/telegram/reply
// exige el secreto con el que Telegram firma cada entrega
// (X-Telegram-Bot-Api-Secret-Token, reenviado por n8n como `webhookSecret`).
// Antes bastaba con conocer el connectionId de la URL del webhook para meter
// mensajes en una conversación y gastar crédito de IA.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  findUnique: vi.fn(),
  replyToIncomingMessage: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { telegramConnection: { findUnique: (...a: unknown[]) => m.findUnique(...a) } },
  isDatabaseConfigured: true,
}));
vi.mock('@/lib/internal-auth', () => ({
  authenticateInternalRequest: () => ({ ok: true }),
  internalAuthFailureResponse: () => null,
}));
vi.mock('@/lib/client-product-access', () => ({ resolveChatbotForChannel: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/chatbot-conversation', () => ({
  replyToIncomingMessage: (...a: unknown[]) => m.replyToIncomingMessage(...a),
}));
vi.mock('@/lib/channel-crypto', () => ({ decryptChannelCredential: () => '123:bot-token' }));
vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));

import { POST } from '@/app/api/internal/channels/telegram/reply/route';
import { telegramWebhookSecret } from '@/lib/telegram-api';

const CONNECTION = {
  id: 'conn_1',
  clientId: 'client_1',
  tenantId: 't1',
  clientProductId: null,
  status: 'active',
  botTokenCiphertext: Buffer.from('x'),
  botTokenIv: Buffer.from('x'),
  botTokenTag: Buffer.from('x'),
};

function call(extra: Record<string, unknown>) {
  const body = { connectionId: 'conn_1', chatId: 42, text: 'Hola', ...extra };
  return POST({ json: async () => body, headers: new Headers() } as unknown as NextRequest);
}

beforeEach(() => {
  m.findUnique.mockReset().mockResolvedValue(CONNECTION);
  m.replyToIncomingMessage.mockReset().mockResolvedValue({ ok: true, conversationId: 'cv_1', reply: 'Hola!' });
});

describe('POST /api/internal/channels/telegram/reply — webhook secret', () => {
  it('rejects a delivery without the secret, before any AI call', async () => {
    const res = await call({});
    expect(res.status).toBe(401);
    expect(m.replyToIncomingMessage).not.toHaveBeenCalled();
  });

  it('rejects a delivery with a wrong secret', async () => {
    const res = await call({ webhookSecret: telegramWebhookSecret('999:otro-bot') });
    expect(res.status).toBe(401);
    expect(m.replyToIncomingMessage).not.toHaveBeenCalled();
  });

  it('answers a delivery carrying the secret derived from this connection\'s bot token', async () => {
    const res = await call({ webhookSecret: telegramWebhookSecret('123:bot-token') });
    expect(res.status).toBe(200);
    expect(m.replyToIncomingMessage).toHaveBeenCalledTimes(1);
  });
});
