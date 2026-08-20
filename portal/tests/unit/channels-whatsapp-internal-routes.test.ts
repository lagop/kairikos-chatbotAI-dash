// =============================================================================
// Canales — unit tests for:
//   POST /api/internal/channels/whatsapp/context
//   POST /api/internal/channels/whatsapp/send
//   POST /api/internal/channels/whatsapp/message
// Same shape as channels-telegram-internal-routes.test.ts.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  metaFindFirst: vi.fn(),
  clientFindUnique: vi.fn(),
  stepFindFirst: vi.fn(),
  conversationFindFirst: vi.fn(),
  conversationCreate: vi.fn(),
  conversationUpdate: vi.fn(),
  decryptMetaToken: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    metaChannelConnection: { findFirst: (...args: unknown[]) => mockState.metaFindFirst(...args) },
    chatbotClient: { findUnique: (...args: unknown[]) => mockState.clientFindUnique(...args) },
    chatbotConfigStep: { findFirst: (...args: unknown[]) => mockState.stepFindFirst(...args) },
    chatbotConversation: {
      findFirst: (...args: unknown[]) => mockState.conversationFindFirst(...args),
      create: (...args: unknown[]) => mockState.conversationCreate(...args),
      update: (...args: unknown[]) => mockState.conversationUpdate(...args),
    },
  },
}));

vi.mock('@/lib/meta-business', () => ({
  decryptMetaToken: (...args: unknown[]) => mockState.decryptMetaToken(...args),
}));

vi.mock('@/lib/whatsapp-api', () => ({
  sendMessage: (...args: unknown[]) => mockState.sendMessage(...args),
}));

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return {
    json: async () => body,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

const VALID_KEY = 'test_portal_api_key';
const activeConnection = {
  id: 'conn_1',
  clientId: 'c1',
  tenantId: 't1',
  channel: 'whatsapp',
  externalId: 'phone_1',
  status: 'active',
  accessTokenCiphertext: Buffer.from('c'),
  accessTokenIv: Buffer.from('i'),
  accessTokenTag: Buffer.from('t'),
};

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.metaFindFirst.mockReset();
  mockState.clientFindUnique.mockReset().mockResolvedValue({ companyName: 'Clínica Orly', name: 'Orly' });
  mockState.stepFindFirst.mockReset().mockResolvedValue(null);
  mockState.conversationFindFirst.mockReset();
  mockState.conversationCreate.mockReset().mockResolvedValue({ id: 'conv_1' });
  mockState.conversationUpdate.mockReset().mockResolvedValue({ id: 'conv_1' });
  mockState.decryptMetaToken.mockReset().mockReturnValue('meta-token-abc');
  mockState.sendMessage.mockReset().mockResolvedValue({ ok: true, data: { messages: [{ id: 'wamid.1' }] } });
  process.env.PORTAL_API_KEY = VALID_KEY;
});

afterEach(() => {
  delete process.env.PORTAL_API_KEY;
});

describe('POST /api/internal/channels/whatsapp/context', () => {
  it('401s without a matching internal key', async () => {
    const { POST } = await import('@/app/api/internal/channels/whatsapp/context/route');
    const res = await POST(makeRequest({ phoneNumberId: 'phone_1' }));
    expect(res.status).toBe(401);
    expect(mockState.metaFindFirst).not.toHaveBeenCalled();
  });

  it('looks up by channel=whatsapp + externalId=phoneNumberId', async () => {
    mockState.metaFindFirst.mockResolvedValue(activeConnection);
    const { POST } = await import('@/app/api/internal/channels/whatsapp/context/route');
    await POST(makeRequest({ phoneNumberId: 'phone_1' }, { 'x-kairikos-internal-key': VALID_KEY }));
    expect(mockState.metaFindFirst).toHaveBeenCalledWith({ where: { channel: 'whatsapp', externalId: 'phone_1' } });
  });

  it('404s when no matching connection exists', async () => {
    mockState.metaFindFirst.mockResolvedValue(null);
    const { POST } = await import('@/app/api/internal/channels/whatsapp/context/route');
    const res = await POST(makeRequest({ phoneNumberId: 'phone_missing' }, { 'x-kairikos-internal-key': VALID_KEY }));
    expect(res.status).toBe(404);
  });

  it('403s when the connection is not active', async () => {
    mockState.metaFindFirst.mockResolvedValue({ ...activeConnection, status: 'revoked' });
    const { POST } = await import('@/app/api/internal/channels/whatsapp/context/route');
    const res = await POST(makeRequest({ phoneNumberId: 'phone_1' }, { 'x-kairikos-internal-key': VALID_KEY }));
    expect(res.status).toBe(403);
  });

  it('returns the business context on success', async () => {
    mockState.metaFindFirst.mockResolvedValue(activeConnection);
    const { POST } = await import('@/app/api/internal/channels/whatsapp/context/route');
    const res = await POST(makeRequest({ phoneNumberId: 'phone_1' }, { 'x-kairikos-internal-key': VALID_KEY }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.businessName).toBe('Clínica Orly');
  });
});

describe('POST /api/internal/channels/whatsapp/send', () => {
  it('401s without a matching internal key', async () => {
    const { POST } = await import('@/app/api/internal/channels/whatsapp/send/route');
    const res = await POST(makeRequest({ phoneNumberId: 'phone_1', to: '34600000000', text: 'hola' }));
    expect(res.status).toBe(401);
  });

  it('decrypts the token and sends via the WhatsApp Cloud API', async () => {
    mockState.metaFindFirst.mockResolvedValue(activeConnection);
    const { POST } = await import('@/app/api/internal/channels/whatsapp/send/route');
    const res = await POST(
      makeRequest({ phoneNumberId: 'phone_1', to: '34600000000', text: 'Hola, ¿en qué puedo ayudarte?' }, { 'x-kairikos-internal-key': VALID_KEY }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, messageId: 'wamid.1' });
    expect(mockState.decryptMetaToken).toHaveBeenCalledWith({
      ciphertext: activeConnection.accessTokenCiphertext,
      iv: activeConnection.accessTokenIv,
      tag: activeConnection.accessTokenTag,
    });
    expect(mockState.sendMessage).toHaveBeenCalledWith('meta-token-abc', 'phone_1', '34600000000', 'Hola, ¿en qué puedo ayudarte?');
  });

  it('502s when Meta rejects the send', async () => {
    mockState.metaFindFirst.mockResolvedValue(activeConnection);
    mockState.sendMessage.mockResolvedValue({ ok: false, error: '24 hour window expired' });
    const { POST } = await import('@/app/api/internal/channels/whatsapp/send/route');
    const res = await POST(
      makeRequest({ phoneNumberId: 'phone_1', to: '34600000000', text: 'hola' }, { 'x-kairikos-internal-key': VALID_KEY }),
    );
    expect(res.status).toBe(502);
  });
});

describe('POST /api/internal/channels/whatsapp/message', () => {
  it('401s without a matching internal key', async () => {
    const { POST } = await import('@/app/api/internal/channels/whatsapp/message/route');
    const res = await POST(makeRequest({ phoneNumberId: 'phone_1', from: '34600000000', role: 'user', content: 'hola' }));
    expect(res.status).toBe(401);
  });

  it('creates a new conversation when there is no recent burst for this sender', async () => {
    mockState.metaFindFirst.mockResolvedValue(activeConnection);
    mockState.conversationFindFirst.mockResolvedValue(null);
    const { POST } = await import('@/app/api/internal/channels/whatsapp/message/route');
    const res = await POST(
      makeRequest(
        { phoneNumberId: 'phone_1', from: '34600000000', role: 'user', content: '¿Abrís el sábado?' },
        { 'x-kairikos-internal-key': VALID_KEY },
      ),
    );
    expect(res.status).toBe(200);
    expect(mockState.conversationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          clientId: 'c1',
          tenantId: 't1',
          externalSessionId: expect.stringMatching(/^whatsapp-34600000000-\d+$/),
        }),
      }),
    );
  });

  it('appends to the most recent conversation when within the inactivity window', async () => {
    mockState.metaFindFirst.mockResolvedValue(activeConnection);
    mockState.conversationFindFirst.mockResolvedValue({
      id: 'conv_1',
      startedAt: new Date(Date.now() - 60_000),
      duration: 30,
      outcome: null,
      transcript: [{ role: 'user', content: 'hola', at: new Date().toISOString() }],
    });
    const { POST } = await import('@/app/api/internal/channels/whatsapp/message/route');
    await POST(
      makeRequest(
        { phoneNumberId: 'phone_1', from: '34600000000', role: 'assistant', content: 'Sí, abrimos.' },
        { 'x-kairikos-internal-key': VALID_KEY },
      ),
    );
    expect(mockState.conversationCreate).not.toHaveBeenCalled();
    const call = mockState.conversationUpdate.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'conv_1' });
    expect(call.data.transcript).toHaveLength(2);
  });

  it('starts a fresh conversation past the inactivity window', async () => {
    mockState.metaFindFirst.mockResolvedValue(activeConnection);
    mockState.conversationFindFirst.mockResolvedValue({
      id: 'conv_old',
      startedAt: new Date(Date.now() - 7 * 60 * 60_000),
      duration: 0,
      outcome: null,
      transcript: [],
    });
    const { POST } = await import('@/app/api/internal/channels/whatsapp/message/route');
    await POST(
      makeRequest(
        { phoneNumberId: 'phone_1', from: '34600000000', role: 'user', content: 'Hola de nuevo' },
        { 'x-kairikos-internal-key': VALID_KEY },
      ),
    );
    expect(mockState.conversationUpdate).not.toHaveBeenCalled();
    expect(mockState.conversationCreate).toHaveBeenCalled();
  });
});
