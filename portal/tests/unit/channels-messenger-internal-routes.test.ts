// =============================================================================
// Canales — unit tests for:
//   POST /api/internal/channels/messenger/context
//   POST /api/internal/channels/messenger/send
//   POST /api/internal/channels/messenger/message
// Same shape as channels-whatsapp-internal-routes.test.ts.
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

vi.mock('@/lib/messenger-api', () => ({
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
  channel: 'messenger',
  externalId: 'page_1',
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
  mockState.decryptMetaToken.mockReset().mockReturnValue('page-token-abc');
  mockState.sendMessage.mockReset().mockResolvedValue({ ok: true, data: { message_id: 'mid.1' } });
  process.env.PORTAL_API_KEY = VALID_KEY;
});

afterEach(() => {
  delete process.env.PORTAL_API_KEY;
});

describe('POST /api/internal/channels/messenger/context', () => {
  it('401s without a matching internal key', async () => {
    const { POST } = await import('@/app/api/internal/channels/messenger/context/route');
    const res = await POST(makeRequest({ pageId: 'page_1' }));
    expect(res.status).toBe(401);
  });

  it('looks up by channel=messenger + externalId=pageId', async () => {
    mockState.metaFindFirst.mockResolvedValue(activeConnection);
    const { POST } = await import('@/app/api/internal/channels/messenger/context/route');
    await POST(makeRequest({ pageId: 'page_1' }, { 'x-kairikos-internal-key': VALID_KEY }));
    expect(mockState.metaFindFirst).toHaveBeenCalledWith({ where: { channel: 'messenger', externalId: 'page_1' } });
  });

  it('404s when no matching connection exists', async () => {
    mockState.metaFindFirst.mockResolvedValue(null);
    const { POST } = await import('@/app/api/internal/channels/messenger/context/route');
    const res = await POST(makeRequest({ pageId: 'page_missing' }, { 'x-kairikos-internal-key': VALID_KEY }));
    expect(res.status).toBe(404);
  });

  it('403s when the connection is not active', async () => {
    mockState.metaFindFirst.mockResolvedValue({ ...activeConnection, status: 'revoked' });
    const { POST } = await import('@/app/api/internal/channels/messenger/context/route');
    const res = await POST(makeRequest({ pageId: 'page_1' }, { 'x-kairikos-internal-key': VALID_KEY }));
    expect(res.status).toBe(403);
  });
});

describe('POST /api/internal/channels/messenger/send', () => {
  it('decrypts the token and sends via the Messenger Send API', async () => {
    mockState.metaFindFirst.mockResolvedValue(activeConnection);
    const { POST } = await import('@/app/api/internal/channels/messenger/send/route');
    const res = await POST(
      makeRequest({ pageId: 'page_1', recipientId: 'psid_1', text: 'Hola' }, { 'x-kairikos-internal-key': VALID_KEY }),
    );
    expect(res.status).toBe(200);
    expect(mockState.sendMessage).toHaveBeenCalledWith('page-token-abc', 'page_1', 'psid_1', 'Hola');
  });

  it('502s when Meta rejects the send', async () => {
    mockState.metaFindFirst.mockResolvedValue(activeConnection);
    mockState.sendMessage.mockResolvedValue({ ok: false, error: 'not available' });
    const { POST } = await import('@/app/api/internal/channels/messenger/send/route');
    const res = await POST(
      makeRequest({ pageId: 'page_1', recipientId: 'psid_1', text: 'hola' }, { 'x-kairikos-internal-key': VALID_KEY }),
    );
    expect(res.status).toBe(502);
  });
});

describe('POST /api/internal/channels/messenger/message', () => {
  it('creates a new conversation when there is no recent burst for this sender', async () => {
    mockState.metaFindFirst.mockResolvedValue(activeConnection);
    mockState.conversationFindFirst.mockResolvedValue(null);
    const { POST } = await import('@/app/api/internal/channels/messenger/message/route');
    await POST(
      makeRequest(
        { pageId: 'page_1', senderId: 'psid_1', role: 'user', content: '¿Abrís el sábado?' },
        { 'x-kairikos-internal-key': VALID_KEY },
      ),
    );
    expect(mockState.conversationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ clientId: 'c1', externalSessionId: expect.stringMatching(/^messenger-psid_1-\d+$/) }),
      }),
    );
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
    const { POST } = await import('@/app/api/internal/channels/messenger/message/route');
    await POST(
      makeRequest({ pageId: 'page_1', senderId: 'psid_1', role: 'user', content: 'Hola de nuevo' }, { 'x-kairikos-internal-key': VALID_KEY }),
    );
    expect(mockState.conversationUpdate).not.toHaveBeenCalled();
    expect(mockState.conversationCreate).toHaveBeenCalled();
  });
});
