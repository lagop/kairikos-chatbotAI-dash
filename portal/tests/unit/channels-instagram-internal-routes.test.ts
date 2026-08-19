// =============================================================================
// Canales — unit tests for:
//   POST /api/internal/channels/instagram/context
//   POST /api/internal/channels/instagram/send
//   POST /api/internal/channels/instagram/message
// Same shape as channels-messenger-internal-routes.test.ts.
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

vi.mock('@/lib/instagram-api', () => ({
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
  channel: 'instagram',
  externalId: 'ig_1',
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
  mockState.decryptMetaToken.mockReset().mockReturnValue('ig-token-abc');
  mockState.sendMessage.mockReset().mockResolvedValue({ ok: true, data: { message_id: 'mid.1' } });
  process.env.PORTAL_API_KEY = VALID_KEY;
});

afterEach(() => {
  delete process.env.PORTAL_API_KEY;
});

describe('POST /api/internal/channels/instagram/context', () => {
  it('401s without a matching internal key', async () => {
    const { POST } = await import('@/app/api/internal/channels/instagram/context/route');
    const res = await POST(makeRequest({ igUserId: 'ig_1' }));
    expect(res.status).toBe(401);
  });

  it('looks up by channel=instagram + externalId=igUserId', async () => {
    mockState.metaFindFirst.mockResolvedValue(activeConnection);
    const { POST } = await import('@/app/api/internal/channels/instagram/context/route');
    await POST(makeRequest({ igUserId: 'ig_1' }, { 'x-kairikos-internal-key': VALID_KEY }));
    expect(mockState.metaFindFirst).toHaveBeenCalledWith({ where: { channel: 'instagram', externalId: 'ig_1' } });
  });

  it('404s when no matching connection exists', async () => {
    mockState.metaFindFirst.mockResolvedValue(null);
    const { POST } = await import('@/app/api/internal/channels/instagram/context/route');
    const res = await POST(makeRequest({ igUserId: 'ig_missing' }, { 'x-kairikos-internal-key': VALID_KEY }));
    expect(res.status).toBe(404);
  });
});

describe('POST /api/internal/channels/instagram/send', () => {
  it('decrypts the token and sends via the Instagram Messaging API', async () => {
    mockState.metaFindFirst.mockResolvedValue(activeConnection);
    const { POST } = await import('@/app/api/internal/channels/instagram/send/route');
    const res = await POST(
      makeRequest({ igUserId: 'ig_1', recipientId: 'ig_sender_1', text: 'Hola' }, { 'x-kairikos-internal-key': VALID_KEY }),
    );
    expect(res.status).toBe(200);
    expect(mockState.sendMessage).toHaveBeenCalledWith('ig-token-abc', 'ig_1', 'ig_sender_1', 'Hola');
  });

  it('502s when Meta rejects the send', async () => {
    mockState.metaFindFirst.mockResolvedValue(activeConnection);
    mockState.sendMessage.mockResolvedValue({ ok: false, error: 'window expired' });
    const { POST } = await import('@/app/api/internal/channels/instagram/send/route');
    const res = await POST(
      makeRequest({ igUserId: 'ig_1', recipientId: 'ig_sender_1', text: 'hola' }, { 'x-kairikos-internal-key': VALID_KEY }),
    );
    expect(res.status).toBe(502);
  });
});

describe('POST /api/internal/channels/instagram/message', () => {
  it('creates a new conversation when there is no recent burst for this sender', async () => {
    mockState.metaFindFirst.mockResolvedValue(activeConnection);
    mockState.conversationFindFirst.mockResolvedValue(null);
    const { POST } = await import('@/app/api/internal/channels/instagram/message/route');
    await POST(
      makeRequest(
        { igUserId: 'ig_1', senderId: 'ig_sender_1', role: 'user', content: '¿Abrís el sábado?' },
        { 'x-kairikos-internal-key': VALID_KEY },
      ),
    );
    expect(mockState.conversationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ clientId: 'c1', externalSessionId: expect.stringMatching(/^instagram-ig_sender_1-\d+$/) }),
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
    const { POST } = await import('@/app/api/internal/channels/instagram/message/route');
    await POST(
      makeRequest(
        { igUserId: 'ig_1', senderId: 'ig_sender_1', role: 'assistant', content: 'Sí, abrimos.' },
        { 'x-kairikos-internal-key': VALID_KEY },
      ),
    );
    expect(mockState.conversationCreate).not.toHaveBeenCalled();
    const call = mockState.conversationUpdate.mock.calls[0][0];
    expect(call.data.transcript).toHaveLength(2);
  });
});
