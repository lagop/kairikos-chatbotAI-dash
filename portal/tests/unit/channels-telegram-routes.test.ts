// =============================================================================
// WP: conexión de canales — unit tests for:
//   POST /api/portal/channels/telegram/connect
//   POST /api/portal/channels/telegram/disconnect
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  fetch: vi.fn(),
  getSession: vi.fn(),
  resolveClientFromSession: vi.fn(),
  isProductContracted: vi.fn(),
  isChannelAllowedForClient: vi.fn(),
  encryptChannelCredential: vi.fn(),
  decryptChannelCredential: vi.fn(),
  deliverChannelEvent: vi.fn(),
  setWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  findUniqueClient: vi.fn(),
  telegramUpsert: vi.fn(),
  telegramFindUnique: vi.fn(),
  telegramUpdate: vi.fn(),
  isDatabaseConfigured: true,
}));

vi.stubGlobal('fetch', mockState.fetch);

vi.mock('@/lib/session', () => ({
  getSession: (...args: unknown[]) => mockState.getSession(...args),
}));

vi.mock('@/lib/portal-session', () => ({
  resolveClientFromSession: (...args: unknown[]) => mockState.resolveClientFromSession(...args),
}));

vi.mock('@/lib/client-product-access', () => ({
  isProductContracted: (...args: unknown[]) => mockState.isProductContracted(...args),
}));

vi.mock('@/lib/channel-access', () => ({
  isChannelAllowedForClient: (...args: unknown[]) => mockState.isChannelAllowedForClient(...args),
}));

vi.mock('@/lib/channel-crypto', () => ({
  encryptChannelCredential: (...args: unknown[]) => mockState.encryptChannelCredential(...args),
  decryptChannelCredential: (...args: unknown[]) => mockState.decryptChannelCredential(...args),
}));

vi.mock('@/lib/channel-webhook', () => ({
  deliverChannelEvent: (...args: unknown[]) => mockState.deliverChannelEvent(...args),
}));

vi.mock('@/lib/telegram-api', () => ({
  setWebhook: (...args: unknown[]) => mockState.setWebhook(...args),
  deleteWebhook: (...args: unknown[]) => mockState.deleteWebhook(...args),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    chatbotClient: { findUnique: (...args: unknown[]) => mockState.findUniqueClient(...args) },
    telegramConnection: {
      upsert: (...args: unknown[]) => mockState.telegramUpsert(...args),
      findUnique: (...args: unknown[]) => mockState.telegramFindUnique(...args),
      update: (...args: unknown[]) => mockState.telegramUpdate(...args),
    },
  },
}));

const SESSION_OK = { hasClientAccess: true };
const SESSION_DENIED = { hasClientAccess: false };
const RESOLVED = { clientId: 'client_1', email: 'a@b.com', source: 'database' as const };

function jsonRequest(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

function telegramGetMeResponse(ok = true, username = 'kairikos_bot') {
  return { ok: true, json: async () => ({ ok, result: ok ? { username } : undefined } as unknown) } as unknown as Response;
}

beforeEach(() => {
  mockState.fetch.mockReset();
  mockState.getSession.mockReset().mockResolvedValue(SESSION_OK);
  mockState.resolveClientFromSession.mockReset().mockResolvedValue(RESOLVED);
  mockState.isProductContracted.mockReset().mockResolvedValue(true);
  mockState.isChannelAllowedForClient.mockReset().mockResolvedValue(true);
  mockState.encryptChannelCredential
    .mockReset()
    .mockReturnValue({ ciphertext: Buffer.from('c'), iv: Buffer.from('i'), tag: Buffer.from('t') });
  mockState.decryptChannelCredential.mockReset().mockReturnValue('123:abc');
  mockState.deliverChannelEvent.mockReset().mockResolvedValue({ ok: true, deliveryId: 'dlv_1', status: 'delivered' });
  mockState.setWebhook.mockReset().mockResolvedValue({ ok: true, data: true });
  mockState.deleteWebhook.mockReset().mockResolvedValue({ ok: true, data: true });
  mockState.findUniqueClient.mockReset().mockResolvedValue({ tenantId: 'tenant_1' });
  mockState.telegramUpsert.mockReset().mockResolvedValue({ id: 'conn_1' });
  mockState.telegramFindUnique.mockReset().mockResolvedValue(null);
  mockState.telegramUpdate.mockReset().mockResolvedValue({});
  mockState.isDatabaseConfigured = true;
  process.env.N8N_TELEGRAM_WEBHOOK_BASE_URL = 'https://n8n.example.com/webhook/kairikos-telegram';
});

afterEach(() => {
  delete process.env.N8N_TELEGRAM_WEBHOOK_BASE_URL;
});

describe('POST /api/portal/channels/telegram/connect', () => {
  it('401s without a real session', async () => {
    mockState.getSession.mockResolvedValue(SESSION_DENIED);
    const { POST } = await import('@/app/api/portal/channels/telegram/connect/route');
    const res = await POST(jsonRequest({ botToken: 'x' }));
    expect(res.status).toBe(401);
    expect(mockState.fetch).not.toHaveBeenCalled();
  });

  it('403s when the client has no active chatbot product', async () => {
    mockState.isProductContracted.mockResolvedValue(false);
    const { POST } = await import('@/app/api/portal/channels/telegram/connect/route');
    const res = await POST(jsonRequest({ botToken: 'x' }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('forbidden');
  });

  it('403s with channel_not_in_plan when the tier does not include telegram', async () => {
    mockState.isChannelAllowedForClient.mockResolvedValue(false);
    const { POST } = await import('@/app/api/portal/channels/telegram/connect/route');
    const res = await POST(jsonRequest({ botToken: 'x' }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('channel_not_in_plan');
    expect(mockState.fetch).not.toHaveBeenCalled();
  });

  it('400s on an invalid body', async () => {
    const { POST } = await import('@/app/api/portal/channels/telegram/connect/route');
    const res = await POST(jsonRequest({}));
    expect(res.status).toBe(400);
  });

  it('400s when Telegram rejects the token', async () => {
    mockState.fetch.mockResolvedValue(telegramGetMeResponse(false));
    const { POST } = await import('@/app/api/portal/channels/telegram/connect/route');
    const res = await POST(jsonRequest({ botToken: 'bad-token' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_token');
    expect(mockState.telegramUpsert).not.toHaveBeenCalled();
    expect(mockState.setWebhook).not.toHaveBeenCalled();
  });

  it('502s when the Telegram getMe API call itself fails', async () => {
    mockState.fetch.mockRejectedValue(new Error('network down'));
    const { POST } = await import('@/app/api/portal/channels/telegram/connect/route');
    const res = await POST(jsonRequest({ botToken: 'x' }));
    expect(res.status).toBe(502);
  });

  it('encrypts the token, upserts the connection, registers the webhook, and delivers the audit event on success', async () => {
    mockState.fetch.mockResolvedValue(telegramGetMeResponse(true, 'kairikos_bot'));
    const { POST } = await import('@/app/api/portal/channels/telegram/connect/route');
    const res = await POST(jsonRequest({ botToken: '123:abc' }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, botUsername: 'kairikos_bot', status: 'active', webhookWarning: false });

    expect(mockState.encryptChannelCredential).toHaveBeenCalledWith('123:abc');
    expect(mockState.telegramUpsert).toHaveBeenCalledWith({
      where: { clientId: 'client_1' },
      update: expect.objectContaining({ botUsername: 'kairikos_bot', status: 'active' }),
      create: expect.objectContaining({ clientId: 'client_1', tenantId: 'tenant_1', botUsername: 'kairikos_bot' }),
    });
    expect(mockState.setWebhook).toHaveBeenCalledWith('123:abc', 'https://n8n.example.com/webhook/kairikos-telegram/conn_1');
    expect(mockState.deliverChannelEvent).toHaveBeenCalledWith({
      connectionType: 'telegram',
      connectionId: 'conn_1',
      clientId: 'client_1',
      payload: { event: 'connected', botUsername: 'kairikos_bot' },
    });
  });

  it('still saves the connection and returns webhookWarning when setWebhook fails — the token IS valid', async () => {
    mockState.fetch.mockResolvedValue(telegramGetMeResponse(true, 'kairikos_bot'));
    mockState.setWebhook.mockResolvedValue({ ok: false, error: 'bad webhook: HTTPS url must be provided' });
    const { POST } = await import('@/app/api/portal/channels/telegram/connect/route');
    const res = await POST(jsonRequest({ botToken: '123:abc' }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, botUsername: 'kairikos_bot', status: 'active', webhookWarning: true });
    expect(mockState.telegramUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'conn_1' }, data: { lastSyncError: 'bad webhook: HTTPS url must be provided' } }),
    );
  });

  it('returns webhookWarning without calling setWebhook when N8N_TELEGRAM_WEBHOOK_BASE_URL is unset', async () => {
    delete process.env.N8N_TELEGRAM_WEBHOOK_BASE_URL;
    mockState.fetch.mockResolvedValue(telegramGetMeResponse(true, 'kairikos_bot'));
    const { POST } = await import('@/app/api/portal/channels/telegram/connect/route');
    const res = await POST(jsonRequest({ botToken: '123:abc' }));
    const body = await res.json();
    expect(body.webhookWarning).toBe(true);
    expect(mockState.setWebhook).not.toHaveBeenCalled();
  });
});

describe('POST /api/portal/channels/telegram/disconnect', () => {
  it('401s without a real session', async () => {
    mockState.getSession.mockResolvedValue(SESSION_DENIED);
    const { POST } = await import('@/app/api/portal/channels/telegram/disconnect/route');
    const res = await POST();
    expect(res.status).toBe(401);
  });

  it('404s when there is no connection to disconnect', async () => {
    mockState.telegramFindUnique.mockResolvedValue(null);
    const { POST } = await import('@/app/api/portal/channels/telegram/disconnect/route');
    const res = await POST();
    expect(res.status).toBe(404);
  });

  it('is idempotent when already revoked, without calling deleteWebhook or re-delivering a webhook', async () => {
    mockState.telegramFindUnique.mockResolvedValue({ id: 'conn_1', status: 'revoked' });
    const { POST } = await import('@/app/api/portal/channels/telegram/disconnect/route');
    const res = await POST();
    const body = await res.json();
    expect(body).toEqual({ ok: true, status: 'revoked', alreadyRevoked: true });
    expect(mockState.telegramUpdate).not.toHaveBeenCalled();
    expect(mockState.deliverChannelEvent).not.toHaveBeenCalled();
    expect(mockState.deleteWebhook).not.toHaveBeenCalled();
  });

  it('calls deleteWebhook, marks an active connection revoked, and delivers the webhook event', async () => {
    mockState.telegramFindUnique.mockResolvedValue({
      id: 'conn_1',
      status: 'active',
      botTokenCiphertext: Buffer.from('c'),
      botTokenIv: Buffer.from('i'),
      botTokenTag: Buffer.from('t'),
    });
    const { POST } = await import('@/app/api/portal/channels/telegram/disconnect/route');
    const res = await POST();
    expect(res.status).toBe(200);
    expect(mockState.deleteWebhook).toHaveBeenCalledWith('123:abc');
    expect(mockState.telegramUpdate).toHaveBeenCalledWith({ where: { id: 'conn_1' }, data: { status: 'revoked' } });
    expect(mockState.deliverChannelEvent).toHaveBeenCalledWith({
      connectionType: 'telegram',
      connectionId: 'conn_1',
      clientId: 'client_1',
      payload: { event: 'disconnected' },
    });
  });

  it('still revokes the connection locally when deleteWebhook fails — never leaves the client stuck', async () => {
    mockState.telegramFindUnique.mockResolvedValue({
      id: 'conn_1',
      status: 'active',
      botTokenCiphertext: Buffer.from('c'),
      botTokenIv: Buffer.from('i'),
      botTokenTag: Buffer.from('t'),
    });
    mockState.deleteWebhook.mockResolvedValue({ ok: false, error: 'network down' });
    const { POST } = await import('@/app/api/portal/channels/telegram/disconnect/route');
    const res = await POST();
    expect(res.status).toBe(200);
    expect(mockState.telegramUpdate).toHaveBeenCalledWith({ where: { id: 'conn_1' }, data: { status: 'revoked' } });
  });
});
