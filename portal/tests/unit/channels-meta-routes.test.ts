// =============================================================================
// WP: conexión de canales — unit tests for:
//   POST /api/portal/channels/meta/complete-signup
//   POST /api/portal/channels/meta/disconnect
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  getSession: vi.fn(),
  resolveClientFromSession: vi.fn(),
  isProductContracted: vi.fn(),
  getAllowedChannelsForClient: vi.fn(),
  isMetaSignupConfigured: vi.fn(),
  exchangeCodeForToken: vi.fn(),
  exchangeForLongLivedToken: vi.fn(),
  fetchPagesWithInstagram: vi.fn(),
  encryptMetaToken: vi.fn(),
  decryptMetaToken: vi.fn(),
  revokeMetaAccess: vi.fn(),
  subscribeWaba: vi.fn(),
  unsubscribeWaba: vi.fn(),
  deliverChannelEvent: vi.fn(),
  findUniqueClient: vi.fn(),
  metaUpsert: vi.fn(),
  metaFindUnique: vi.fn(),
  metaUpdate: vi.fn(),
  isDatabaseConfigured: true,
}));

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
  getAllowedChannelsForClient: (...args: unknown[]) => mockState.getAllowedChannelsForClient(...args),
}));

vi.mock('@/lib/meta-business', () => ({
  isMetaSignupConfigured: (...args: unknown[]) => mockState.isMetaSignupConfigured(...args),
  exchangeCodeForToken: (...args: unknown[]) => mockState.exchangeCodeForToken(...args),
  exchangeForLongLivedToken: (...args: unknown[]) => mockState.exchangeForLongLivedToken(...args),
  fetchPagesWithInstagram: (...args: unknown[]) => mockState.fetchPagesWithInstagram(...args),
  encryptMetaToken: (...args: unknown[]) => mockState.encryptMetaToken(...args),
  decryptMetaToken: (...args: unknown[]) => mockState.decryptMetaToken(...args),
  revokeMetaAccess: (...args: unknown[]) => mockState.revokeMetaAccess(...args),
}));

vi.mock('@/lib/whatsapp-api', () => ({
  subscribeWaba: (...args: unknown[]) => mockState.subscribeWaba(...args),
  unsubscribeWaba: (...args: unknown[]) => mockState.unsubscribeWaba(...args),
}));

vi.mock('@/lib/channel-webhook', () => ({
  deliverChannelEvent: (...args: unknown[]) => mockState.deliverChannelEvent(...args),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    chatbotClient: { findUnique: (...args: unknown[]) => mockState.findUniqueClient(...args) },
    metaChannelConnection: {
      upsert: (...args: unknown[]) => mockState.metaUpsert(...args),
      findUnique: (...args: unknown[]) => mockState.metaFindUnique(...args),
      update: (...args: unknown[]) => mockState.metaUpdate(...args),
    },
  },
}));

const SESSION_OK = { hasClientAccess: true };
const SESSION_DENIED = { hasClientAccess: false };
const RESOLVED = { clientId: 'client_1', email: 'a@b.com', source: 'database' as const };

function jsonRequest(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  mockState.getSession.mockReset().mockResolvedValue(SESSION_OK);
  mockState.resolveClientFromSession.mockReset().mockResolvedValue(RESOLVED);
  mockState.isProductContracted.mockReset().mockResolvedValue(true);
  mockState.getAllowedChannelsForClient.mockReset().mockResolvedValue(['whatsapp', 'messenger', 'instagram']);
  mockState.isMetaSignupConfigured.mockReset().mockReturnValue(true);
  mockState.exchangeCodeForToken.mockReset().mockResolvedValue({ accessToken: 'short_lived', expiresIn: 5400 });
  mockState.exchangeForLongLivedToken.mockReset().mockResolvedValue({ accessToken: 'long_lived', expiresIn: 5183944 });
  mockState.fetchPagesWithInstagram.mockReset().mockResolvedValue([]);
  mockState.encryptMetaToken
    .mockReset()
    .mockReturnValue({ ciphertext: Buffer.from('c'), iv: Buffer.from('i'), tag: Buffer.from('t') });
  mockState.decryptMetaToken.mockReset().mockReturnValue('long_lived');
  mockState.revokeMetaAccess.mockReset().mockResolvedValue(true);
  mockState.subscribeWaba.mockReset().mockResolvedValue({ ok: true, data: { success: true } });
  mockState.unsubscribeWaba.mockReset().mockResolvedValue({ ok: true, data: { success: true } });
  mockState.deliverChannelEvent.mockReset().mockResolvedValue({ ok: true, deliveryId: 'dlv_1', status: 'delivered' });
  mockState.findUniqueClient.mockReset().mockResolvedValue({ tenantId: 'tenant_1' });
  mockState.metaUpsert.mockReset().mockResolvedValue({ id: 'conn_1' });
  mockState.metaFindUnique.mockReset().mockResolvedValue(null);
  mockState.metaUpdate.mockReset().mockResolvedValue({});
  mockState.isDatabaseConfigured = true;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/portal/channels/meta/complete-signup', () => {
  it('401s without a real session', async () => {
    mockState.getSession.mockResolvedValue(SESSION_DENIED);
    const { POST } = await import('@/app/api/portal/channels/meta/complete-signup/route');
    const res = await POST(jsonRequest({ code: 'x' }));
    expect(res.status).toBe(401);
  });

  it('503s when Meta signup is not configured', async () => {
    mockState.isMetaSignupConfigured.mockReturnValue(false);
    const { POST } = await import('@/app/api/portal/channels/meta/complete-signup/route');
    const res = await POST(jsonRequest({ code: 'x' }));
    expect(res.status).toBe(503);
  });

  it('403s when the client has no active chatbot product', async () => {
    mockState.isProductContracted.mockResolvedValue(false);
    const { POST } = await import('@/app/api/portal/channels/meta/complete-signup/route');
    const res = await POST(jsonRequest({ code: 'x' }));
    expect(res.status).toBe(403);
  });

  it('403s with channel_not_in_plan when the tier includes no Meta channel at all', async () => {
    mockState.getAllowedChannelsForClient.mockResolvedValue(['web']);
    const { POST } = await import('@/app/api/portal/channels/meta/complete-signup/route');
    const res = await POST(jsonRequest({ code: 'x' }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('channel_not_in_plan');
  });

  it('400s on an invalid body', async () => {
    const { POST } = await import('@/app/api/portal/channels/meta/complete-signup/route');
    const res = await POST(jsonRequest({}));
    expect(res.status).toBe(400);
  });

  it('502s when the code exchange fails', async () => {
    mockState.exchangeCodeForToken.mockResolvedValue(null);
    const { POST } = await import('@/app/api/portal/channels/meta/complete-signup/route');
    const res = await POST(jsonRequest({ code: 'bad_code' }));
    expect(res.status).toBe(502);
  });

  it('connects the WhatsApp surface when provided and allowed, storing wabaId and subscribing the app', async () => {
    const { POST } = await import('@/app/api/portal/channels/meta/complete-signup/route');
    const res = await POST(jsonRequest({ code: 'auth_code', whatsapp: { wabaId: 'waba_1', phoneNumberId: 'phone_1' } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connected).toEqual([{ channel: 'whatsapp', externalId: 'phone_1', label: 'WhatsApp (waba_1)' }]);
    expect(mockState.metaUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clientId_channel_externalId: { clientId: 'client_1', channel: 'whatsapp', externalId: 'phone_1' } },
        update: expect.objectContaining({ wabaId: 'waba_1' }),
        create: expect.objectContaining({ wabaId: 'waba_1' }),
      }),
    );
    expect(mockState.subscribeWaba).toHaveBeenCalledWith('long_lived', 'waba_1');
    expect(mockState.deliverChannelEvent).toHaveBeenCalledWith({
      connectionType: 'meta',
      connectionId: 'conn_1',
      clientId: 'client_1',
      payload: { event: 'connected', channel: 'whatsapp', externalId: 'phone_1', label: 'WhatsApp (waba_1)' },
    });
  });

  it('never calls subscribeWaba for messenger/instagram surfaces', async () => {
    mockState.fetchPagesWithInstagram.mockResolvedValue([
      { pageId: 'page_1', pageName: 'Peluquería Aurora', instagramAccountId: 'ig_1' },
    ]);
    const { POST } = await import('@/app/api/portal/channels/meta/complete-signup/route');
    await POST(jsonRequest({ code: 'auth_code' }));
    expect(mockState.subscribeWaba).not.toHaveBeenCalled();
  });

  it('still connects the surface, recording lastSyncError, when subscribeWaba fails — the token IS valid', async () => {
    mockState.subscribeWaba.mockResolvedValue({ ok: false, error: 'Invalid OAuth access token' });
    const { POST } = await import('@/app/api/portal/channels/meta/complete-signup/route');
    const res = await POST(jsonRequest({ code: 'auth_code', whatsapp: { wabaId: 'waba_1', phoneNumberId: 'phone_1' } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connected).toEqual([{ channel: 'whatsapp', externalId: 'phone_1', label: 'WhatsApp (waba_1)' }]);
    expect(mockState.metaUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'conn_1' }, data: { lastSyncError: 'Invalid OAuth access token' } }),
    );
  });

  it('connects messenger and instagram for every discovered page', async () => {
    mockState.fetchPagesWithInstagram.mockResolvedValue([
      { pageId: 'page_1', pageName: 'Peluquería Aurora', instagramAccountId: 'ig_1' },
      { pageId: 'page_2', pageName: 'Aurora Spa', instagramAccountId: null },
    ]);
    const { POST } = await import('@/app/api/portal/channels/meta/complete-signup/route');
    const res = await POST(jsonRequest({ code: 'auth_code' }));
    const body = await res.json();
    expect(body.connected).toEqual([
      { channel: 'messenger', externalId: 'page_1', label: 'Peluquería Aurora' },
      { channel: 'instagram', externalId: 'ig_1', label: 'Peluquería Aurora' },
      { channel: 'messenger', externalId: 'page_2', label: 'Aurora Spa' },
    ]);
  });

  it('reports blocked channels instead of connecting them when the tier excludes them', async () => {
    mockState.getAllowedChannelsForClient.mockResolvedValue(['messenger']);
    mockState.fetchPagesWithInstagram.mockResolvedValue([
      { pageId: 'page_1', pageName: 'Peluquería Aurora', instagramAccountId: 'ig_1' },
    ]);
    const { POST } = await import('@/app/api/portal/channels/meta/complete-signup/route');
    const res = await POST(jsonRequest({ code: 'auth_code', whatsapp: { wabaId: 'w', phoneNumberId: 'p' } }));
    const body = await res.json();
    expect(body.connected).toEqual([{ channel: 'messenger', externalId: 'page_1', label: 'Peluquería Aurora' }]);
    expect(body.blocked.sort()).toEqual(['instagram', 'whatsapp']);
  });

  it('409s when nothing ends up connected', async () => {
    mockState.getAllowedChannelsForClient.mockResolvedValue(['whatsapp']);
    mockState.fetchPagesWithInstagram.mockResolvedValue([]);
    const { POST } = await import('@/app/api/portal/channels/meta/complete-signup/route');
    const res = await POST(jsonRequest({ code: 'auth_code' }));
    expect(res.status).toBe(409);
  });

  it('falls back to the short-lived token when the long-lived exchange fails', async () => {
    mockState.exchangeForLongLivedToken.mockResolvedValue(null);
    const { POST } = await import('@/app/api/portal/channels/meta/complete-signup/route');
    const res = await POST(jsonRequest({ code: 'auth_code', whatsapp: { wabaId: 'w', phoneNumberId: 'p' } }));
    expect(res.status).toBe(200);
    expect(mockState.encryptMetaToken).toHaveBeenCalledWith('short_lived');
  });
});

describe('POST /api/portal/channels/meta/disconnect', () => {
  it('401s without a real session', async () => {
    mockState.getSession.mockResolvedValue(SESSION_DENIED);
    const { POST } = await import('@/app/api/portal/channels/meta/disconnect/route');
    const res = await POST(jsonRequest({ connectionId: '00000000-0000-0000-0000-000000000001' }));
    expect(res.status).toBe(401);
  });

  it('400s on an invalid body', async () => {
    const { POST } = await import('@/app/api/portal/channels/meta/disconnect/route');
    const res = await POST(jsonRequest({ connectionId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
  });

  it('404s when the connection does not belong to this client', async () => {
    mockState.metaFindUnique.mockResolvedValue({ id: 'conn_1', clientId: 'someone_else', status: 'active' });
    const { POST } = await import('@/app/api/portal/channels/meta/disconnect/route');
    const res = await POST(jsonRequest({ connectionId: '00000000-0000-0000-0000-000000000001' }));
    expect(res.status).toBe(404);
  });

  it('404s when the connection does not exist', async () => {
    mockState.metaFindUnique.mockResolvedValue(null);
    const { POST } = await import('@/app/api/portal/channels/meta/disconnect/route');
    const res = await POST(jsonRequest({ connectionId: '00000000-0000-0000-0000-000000000001' }));
    expect(res.status).toBe(404);
  });

  it('is idempotent when already revoked, without re-revoking or re-delivering', async () => {
    mockState.metaFindUnique.mockResolvedValue({ id: 'conn_1', clientId: 'client_1', status: 'revoked' });
    const { POST } = await import('@/app/api/portal/channels/meta/disconnect/route');
    const res = await POST(jsonRequest({ connectionId: '00000000-0000-0000-0000-000000000001' }));
    const body = await res.json();
    expect(body).toEqual({ ok: true, status: 'revoked', alreadyRevoked: true });
    expect(mockState.revokeMetaAccess).not.toHaveBeenCalled();
    expect(mockState.deliverChannelEvent).not.toHaveBeenCalled();
  });

  it('revokes at Meta best-effort and marks the row revoked locally regardless', async () => {
    mockState.metaFindUnique.mockResolvedValue({
      id: 'conn_1',
      clientId: 'client_1',
      status: 'active',
      channel: 'messenger',
      externalId: 'page_1',
      accessTokenCiphertext: Buffer.from('c'),
      accessTokenIv: Buffer.from('i'),
      accessTokenTag: Buffer.from('t'),
    });
    const { POST } = await import('@/app/api/portal/channels/meta/disconnect/route');
    const res = await POST(jsonRequest({ connectionId: '00000000-0000-0000-0000-000000000001' }));
    const body = await res.json();
    expect(body).toEqual({ ok: true, status: 'revoked', revokedAtMeta: true });
    expect(mockState.metaUpdate).toHaveBeenCalledWith({ where: { id: 'conn_1' }, data: { status: 'revoked' } });
    expect(mockState.unsubscribeWaba).not.toHaveBeenCalled();
  });

  it('unsubscribes the WABA before revoking when disconnecting a whatsapp connection', async () => {
    mockState.metaFindUnique.mockResolvedValue({
      id: 'conn_1',
      clientId: 'client_1',
      status: 'active',
      channel: 'whatsapp',
      externalId: 'phone_1',
      wabaId: 'waba_1',
      accessTokenCiphertext: Buffer.from('c'),
      accessTokenIv: Buffer.from('i'),
      accessTokenTag: Buffer.from('t'),
    });
    const { POST } = await import('@/app/api/portal/channels/meta/disconnect/route');
    const res = await POST(jsonRequest({ connectionId: '00000000-0000-0000-0000-000000000001' }));
    expect(res.status).toBe(200);
    expect(mockState.unsubscribeWaba).toHaveBeenCalledWith('long_lived', 'waba_1');
    expect(mockState.metaUpdate).toHaveBeenCalledWith({ where: { id: 'conn_1' }, data: { status: 'revoked' } });
  });

  it('still revokes locally when unsubscribeWaba fails — never blocks the disconnect', async () => {
    mockState.metaFindUnique.mockResolvedValue({
      id: 'conn_1',
      clientId: 'client_1',
      status: 'active',
      channel: 'whatsapp',
      externalId: 'phone_1',
      wabaId: 'waba_1',
      accessTokenCiphertext: Buffer.from('c'),
      accessTokenIv: Buffer.from('i'),
      accessTokenTag: Buffer.from('t'),
    });
    mockState.unsubscribeWaba.mockResolvedValue({ ok: false, error: 'network down' });
    const { POST } = await import('@/app/api/portal/channels/meta/disconnect/route');
    const res = await POST(jsonRequest({ connectionId: '00000000-0000-0000-0000-000000000001' }));
    expect(res.status).toBe(200);
    expect(mockState.metaUpdate).toHaveBeenCalledWith({ where: { id: 'conn_1' }, data: { status: 'revoked' } });
  });

  it('still marks the row revoked locally even when the remote revoke throws', async () => {
    mockState.metaFindUnique.mockResolvedValue({
      id: 'conn_1',
      clientId: 'client_1',
      status: 'active',
      channel: 'messenger',
      externalId: 'page_1',
      accessTokenCiphertext: Buffer.from('c'),
      accessTokenIv: Buffer.from('i'),
      accessTokenTag: Buffer.from('t'),
    });
    mockState.decryptMetaToken.mockImplementation(() => {
      throw new Error('decrypt failed');
    });
    const { POST } = await import('@/app/api/portal/channels/meta/disconnect/route');
    const res = await POST(jsonRequest({ connectionId: '00000000-0000-0000-0000-000000000001' }));
    expect(res.status).toBe(200);
    expect(mockState.metaUpdate).toHaveBeenCalled();
  });
});
