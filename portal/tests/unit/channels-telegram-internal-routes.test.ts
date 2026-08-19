// =============================================================================
// Canales — unit tests for:
//   POST /api/internal/channels/telegram/context
//   POST /api/internal/channels/telegram/send
//   POST /api/internal/channels/telegram/message
// Same shape as channels-web-internal-routes.test.ts (Fase 4).
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  telegramFindUnique: vi.fn(),
  clientFindUnique: vi.fn(),
  stepFindFirst: vi.fn(),
  conversationFindFirst: vi.fn(),
  conversationCreate: vi.fn(),
  conversationUpdate: vi.fn(),
  decryptChannelCredential: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    telegramConnection: { findUnique: (...args: unknown[]) => mockState.telegramFindUnique(...args) },
    chatbotClient: { findUnique: (...args: unknown[]) => mockState.clientFindUnique(...args) },
    chatbotConfigStep: { findFirst: (...args: unknown[]) => mockState.stepFindFirst(...args) },
    chatbotConversation: {
      findFirst: (...args: unknown[]) => mockState.conversationFindFirst(...args),
      create: (...args: unknown[]) => mockState.conversationCreate(...args),
      update: (...args: unknown[]) => mockState.conversationUpdate(...args),
    },
  },
}));

vi.mock('@/lib/channel-crypto', () => ({
  decryptChannelCredential: (...args: unknown[]) => mockState.decryptChannelCredential(...args),
}));

vi.mock('@/lib/telegram-api', () => ({
  sendMessage: (...args: unknown[]) => mockState.sendMessage(...args),
}));

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return {
    json: async () => body,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

const VALID_KEY = 'test_portal_api_key';
const activeConnection = { id: 'conn_1', clientId: 'c1', tenantId: 't1', status: 'active', botTokenCiphertext: Buffer.from('c'), botTokenIv: Buffer.from('i'), botTokenTag: Buffer.from('t') };

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.telegramFindUnique.mockReset();
  mockState.clientFindUnique.mockReset().mockResolvedValue({ companyName: 'Clínica Orly', name: 'Orly' });
  mockState.stepFindFirst.mockReset().mockResolvedValue(null);
  mockState.conversationFindFirst.mockReset();
  mockState.conversationCreate.mockReset().mockResolvedValue({ id: 'conv_1' });
  mockState.conversationUpdate.mockReset().mockResolvedValue({ id: 'conv_1' });
  mockState.decryptChannelCredential.mockReset().mockReturnValue('123:abc');
  mockState.sendMessage.mockReset().mockResolvedValue({ ok: true, data: { message_id: 55 } });
  process.env.PORTAL_API_KEY = VALID_KEY;
});

afterEach(() => {
  delete process.env.PORTAL_API_KEY;
});

describe('POST /api/internal/channels/telegram/context', () => {
  it('401s without a matching internal key', async () => {
    const { POST } = await import('@/app/api/internal/channels/telegram/context/route');
    const res = await POST(makeRequest({ connectionId: 'conn_1' }));
    expect(res.status).toBe(401);
    expect(mockState.telegramFindUnique).not.toHaveBeenCalled();
  });

  it('404s when the connectionId does not match any TelegramConnection', async () => {
    mockState.telegramFindUnique.mockResolvedValue(null);
    const { POST } = await import('@/app/api/internal/channels/telegram/context/route');
    const res = await POST(makeRequest({ connectionId: 'conn_missing' }, { 'x-kairikos-internal-key': VALID_KEY }));
    expect(res.status).toBe(404);
  });

  it('403s when the connection is not active', async () => {
    mockState.telegramFindUnique.mockResolvedValue({ ...activeConnection, status: 'revoked' });
    const { POST } = await import('@/app/api/internal/channels/telegram/context/route');
    const res = await POST(makeRequest({ connectionId: 'conn_1' }, { 'x-kairikos-internal-key': VALID_KEY }));
    expect(res.status).toBe(403);
  });

  it('returns the business context on success', async () => {
    mockState.telegramFindUnique.mockResolvedValue(activeConnection);
    const { POST } = await import('@/app/api/internal/channels/telegram/context/route');
    const res = await POST(makeRequest({ connectionId: 'conn_1' }, { 'x-kairikos-internal-key': VALID_KEY }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.clientId).toBe('c1');
    expect(body.businessName).toBe('Clínica Orly');
  });
});

describe('POST /api/internal/channels/telegram/send', () => {
  it('401s without a matching internal key', async () => {
    const { POST } = await import('@/app/api/internal/channels/telegram/send/route');
    const res = await POST(makeRequest({ connectionId: 'conn_1', chatId: 1, text: 'hola' }));
    expect(res.status).toBe(401);
  });

  it('404s when the connection does not exist', async () => {
    mockState.telegramFindUnique.mockResolvedValue(null);
    const { POST } = await import('@/app/api/internal/channels/telegram/send/route');
    const res = await POST(makeRequest({ connectionId: 'conn_x', chatId: 1, text: 'hola' }, { 'x-kairikos-internal-key': VALID_KEY }));
    expect(res.status).toBe(404);
  });

  it('decrypts the token and sends the message', async () => {
    mockState.telegramFindUnique.mockResolvedValue(activeConnection);
    const { POST } = await import('@/app/api/internal/channels/telegram/send/route');
    const res = await POST(makeRequest({ connectionId: 'conn_1', chatId: 987, text: 'Hola, ¿en qué puedo ayudarte?' }, { 'x-kairikos-internal-key': VALID_KEY }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, messageId: 55 });
    expect(mockState.decryptChannelCredential).toHaveBeenCalledWith({
      ciphertext: activeConnection.botTokenCiphertext,
      iv: activeConnection.botTokenIv,
      tag: activeConnection.botTokenTag,
    });
    expect(mockState.sendMessage).toHaveBeenCalledWith('123:abc', 987, 'Hola, ¿en qué puedo ayudarte?');
  });

  it('502s when Telegram rejects the send (e.g. user blocked the bot)', async () => {
    mockState.telegramFindUnique.mockResolvedValue(activeConnection);
    mockState.sendMessage.mockResolvedValue({ ok: false, error: 'Forbidden: bot was blocked by the user' });
    const { POST } = await import('@/app/api/internal/channels/telegram/send/route');
    const res = await POST(makeRequest({ connectionId: 'conn_1', chatId: 987, text: 'hola' }, { 'x-kairikos-internal-key': VALID_KEY }));
    expect(res.status).toBe(502);
  });
});

describe('POST /api/internal/channels/telegram/message', () => {
  it('401s without a matching internal key', async () => {
    const { POST } = await import('@/app/api/internal/channels/telegram/message/route');
    const res = await POST(makeRequest({ connectionId: 'conn_1', chatId: 1, role: 'user', content: 'hola' }));
    expect(res.status).toBe(401);
  });

  it('creates a new conversation when there is no recent burst for this chat', async () => {
    mockState.telegramFindUnique.mockResolvedValue(activeConnection);
    mockState.conversationFindFirst.mockResolvedValue(null);
    const { POST } = await import('@/app/api/internal/channels/telegram/message/route');
    const res = await POST(
      makeRequest({ connectionId: 'conn_1', chatId: 987, role: 'user', content: '¿Abrís el sábado?' }, { 'x-kairikos-internal-key': VALID_KEY }),
    );
    expect(res.status).toBe(200);
    expect(mockState.conversationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          clientId: 'c1',
          tenantId: 't1',
          externalSessionId: expect.stringMatching(/^telegram-987-\d+$/),
        }),
      }),
    );
  });

  it('appends to the most recent conversation when its last activity is within the inactivity window', async () => {
    mockState.telegramFindUnique.mockResolvedValue(activeConnection);
    mockState.conversationFindFirst.mockResolvedValue({
      id: 'conv_1',
      startedAt: new Date(Date.now() - 60_000),
      duration: 30,
      outcome: null,
      transcript: [{ role: 'user', content: 'hola', at: new Date().toISOString() }],
    });
    const { POST } = await import('@/app/api/internal/channels/telegram/message/route');
    await POST(
      makeRequest({ connectionId: 'conn_1', chatId: 987, role: 'assistant', content: 'Sí, abrimos.' }, { 'x-kairikos-internal-key': VALID_KEY }),
    );
    expect(mockState.conversationCreate).not.toHaveBeenCalled();
    const call = mockState.conversationUpdate.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'conv_1' });
    expect(call.data.transcript).toHaveLength(2);
  });

  it('starts a fresh conversation when the most recent one is past the inactivity window', async () => {
    mockState.telegramFindUnique.mockResolvedValue(activeConnection);
    mockState.conversationFindFirst.mockResolvedValue({
      id: 'conv_old',
      startedAt: new Date(Date.now() - 7 * 60 * 60_000),
      duration: 0,
      outcome: null,
      transcript: [],
    });
    const { POST } = await import('@/app/api/internal/channels/telegram/message/route');
    await POST(
      makeRequest({ connectionId: 'conn_1', chatId: 987, role: 'user', content: 'Hola de nuevo' }, { 'x-kairikos-internal-key': VALID_KEY }),
    );
    expect(mockState.conversationUpdate).not.toHaveBeenCalled();
    expect(mockState.conversationCreate).toHaveBeenCalled();
  });

  it('only overwrites outcome when the caller sends one', async () => {
    mockState.telegramFindUnique.mockResolvedValue(activeConnection);
    mockState.conversationFindFirst.mockResolvedValue({
      id: 'conv_1',
      startedAt: new Date(),
      duration: 0,
      outcome: 'resolved',
      transcript: [],
    });
    const { POST } = await import('@/app/api/internal/channels/telegram/message/route');
    await POST(makeRequest({ connectionId: 'conn_1', chatId: 987, role: 'user', content: 'gracias' }, { 'x-kairikos-internal-key': VALID_KEY }));
    expect(mockState.conversationUpdate.mock.calls[0][0].data.outcome).toBe('resolved');
  });
});
