// =============================================================================
// Canales Fase 4 — unit tests for:
//   POST /api/portal/channels/web/enable
//   POST /api/portal/channels/web/disable
//   PATCH /api/portal/channels/web
// Same triple-gate pattern as channels-telegram-routes.test.ts.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  getSession: vi.fn(),
  resolveClientFromSession: vi.fn(),
  isProductContracted: vi.fn(),
  isChannelAllowedForClient: vi.fn(),
  deliverChannelEvent: vi.fn(),
  findUniqueClient: vi.fn(),
  embedFindFirst: vi.fn(),
  embedUpdate: vi.fn(),
  embedCreate: vi.fn(),
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
  isChannelAllowedForClient: (...args: unknown[]) => mockState.isChannelAllowedForClient(...args),
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
    chatWebEmbed: {
      findFirst: (...args: unknown[]) => mockState.embedFindFirst(...args),
      update: (...args: unknown[]) => mockState.embedUpdate(...args),
      create: (...args: unknown[]) => mockState.embedCreate(...args),
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
  mockState.isChannelAllowedForClient.mockReset().mockResolvedValue(true);
  mockState.deliverChannelEvent.mockReset().mockResolvedValue({ ok: true, deliveryId: 'dlv_1', status: 'delivered' });
  mockState.findUniqueClient.mockReset().mockResolvedValue({ tenantId: 'tenant_1' });
  mockState.embedFindFirst.mockReset().mockResolvedValue(null);
  mockState.embedUpdate.mockReset().mockResolvedValue({ id: 'embed_1', publicToken: 'wgt_existing', status: 'active', primaryColor: '#0E6B5E', position: 'bottom-right' });
  mockState.embedCreate.mockReset().mockResolvedValue({ id: 'embed_1', publicToken: 'wgt_new', status: 'active', primaryColor: '#0E6B5E', position: 'bottom-right' });
  mockState.isDatabaseConfigured = true;
});

describe('POST /api/portal/channels/web/enable', () => {
  it('401s without a real session', async () => {
    mockState.getSession.mockResolvedValue(SESSION_DENIED);
    const { POST } = await import('@/app/api/portal/channels/web/enable/route');
    const res = await POST();
    expect(res.status).toBe(401);
  });

  it('403s when the client has no active chatbot product', async () => {
    mockState.isProductContracted.mockResolvedValue(false);
    const { POST } = await import('@/app/api/portal/channels/web/enable/route');
    const res = await POST();
    expect(res.status).toBe(403);
  });

  it('403s with channel_not_in_plan when the tier does not include web', async () => {
    mockState.isChannelAllowedForClient.mockResolvedValue(false);
    const { POST } = await import('@/app/api/portal/channels/web/enable/route');
    const res = await POST();
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.error).toBe('channel_not_in_plan');
  });

  it('creates a new embed with a fresh publicToken when none exists yet', async () => {
    const { POST } = await import('@/app/api/portal/channels/web/enable/route');
    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.publicToken).toBe('wgt_new');
    expect(mockState.embedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          clientId: 'client_1',
          tenantId: 'tenant_1',
          status: 'active',
          publicToken: expect.stringMatching(/^wgt_/),
        }),
      }),
    );
    expect(mockState.deliverChannelEvent).toHaveBeenCalledWith(
      expect.objectContaining({ connectionType: 'web', clientId: 'client_1' }),
    );
  });

  it('is idempotent — re-enabling an existing embed keeps the same publicToken', async () => {
    mockState.embedFindFirst.mockResolvedValue({ id: 'embed_1', publicToken: 'wgt_existing', status: 'disabled' });
    const { POST } = await import('@/app/api/portal/channels/web/enable/route');
    const res = await POST();
    const body = await res.json();
    expect(body.publicToken).toBe('wgt_existing');
    expect(mockState.embedCreate).not.toHaveBeenCalled();
    expect(mockState.embedUpdate).toHaveBeenCalledWith({ where: { id: 'embed_1' }, data: { status: 'active' } });
  });
});

describe('POST /api/portal/channels/web/disable', () => {
  it('401s without a real session', async () => {
    mockState.getSession.mockResolvedValue(SESSION_DENIED);
    const { POST } = await import('@/app/api/portal/channels/web/disable/route');
    const res = await POST();
    expect(res.status).toBe(401);
  });

  it('404s when there is no embed to disable', async () => {
    mockState.embedFindFirst.mockResolvedValue(null);
    const { POST } = await import('@/app/api/portal/channels/web/disable/route');
    const res = await POST();
    expect(res.status).toBe(404);
  });

  it('is idempotent when already disabled, without re-delivering a webhook', async () => {
    mockState.embedFindFirst.mockResolvedValue({ id: 'embed_1', status: 'disabled' });
    const { POST } = await import('@/app/api/portal/channels/web/disable/route');
    const res = await POST();
    const body = await res.json();
    expect(body).toEqual({ ok: true, status: 'disabled', alreadyDisabled: true });
    expect(mockState.embedUpdate).not.toHaveBeenCalled();
    expect(mockState.deliverChannelEvent).not.toHaveBeenCalled();
  });

  it('marks an active embed disabled and delivers the webhook event', async () => {
    mockState.embedFindFirst.mockResolvedValue({ id: 'embed_1', status: 'active' });
    const { POST } = await import('@/app/api/portal/channels/web/disable/route');
    const res = await POST();
    expect(res.status).toBe(200);
    expect(mockState.embedUpdate).toHaveBeenCalledWith({ where: { id: 'embed_1' }, data: { status: 'disabled' } });
    expect(mockState.deliverChannelEvent).toHaveBeenCalledWith(
      expect.objectContaining({ connectionType: 'web', payload: { event: 'disconnected' } }),
    );
  });
});

describe('PATCH /api/portal/channels/web', () => {
  it('401s without a real session', async () => {
    mockState.getSession.mockResolvedValue(SESSION_DENIED);
    const { PATCH } = await import('@/app/api/portal/channels/web/route');
    const res = await PATCH(jsonRequest({ primaryColor: '#000000', position: 'bottom-right' }));
    expect(res.status).toBe(401);
  });

  it('400s on an invalid hex color', async () => {
    const { PATCH } = await import('@/app/api/portal/channels/web/route');
    const res = await PATCH(jsonRequest({ primaryColor: 'red', position: 'bottom-right' }));
    expect(res.status).toBe(400);
  });

  it('400s on an invalid position', async () => {
    const { PATCH } = await import('@/app/api/portal/channels/web/route');
    const res = await PATCH(jsonRequest({ primaryColor: '#000000', position: 'top-center' }));
    expect(res.status).toBe(400);
  });

  it('404s when there is no embed to update', async () => {
    mockState.embedFindFirst.mockResolvedValue(null);
    const { PATCH } = await import('@/app/api/portal/channels/web/route');
    const res = await PATCH(jsonRequest({ primaryColor: '#000000', position: 'bottom-right' }));
    expect(res.status).toBe(404);
  });

  it('updates color and position', async () => {
    mockState.embedFindFirst.mockResolvedValue({ id: 'embed_1' });
    mockState.embedUpdate.mockResolvedValue({ primaryColor: '#123456', position: 'bottom-left' });
    const { PATCH } = await import('@/app/api/portal/channels/web/route');
    const res = await PATCH(jsonRequest({ primaryColor: '#123456', position: 'bottom-left' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, primaryColor: '#123456', position: 'bottom-left' });
    expect(mockState.embedUpdate).toHaveBeenCalledWith({
      where: { id: 'embed_1' },
      data: { primaryColor: '#123456', position: 'bottom-left' },
    });
  });
});
