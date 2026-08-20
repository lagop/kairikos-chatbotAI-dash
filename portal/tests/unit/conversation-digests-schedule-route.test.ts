// =============================================================================
// Canales Fase 7 — unit tests for:
//   GET/PATCH /api/portal/conversation-digests/schedule
// Same double-gate pattern (getSession → resolveClientFromSession →
// isProductContracted) as channels-telegram-routes.test.ts.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  getSession: vi.fn(),
  resolveClientFromSession: vi.fn(),
  isProductContracted: vi.fn(),
  scheduleFindUnique: vi.fn(),
  scheduleUpsert: vi.fn(),
  findUniqueClient: vi.fn(),
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

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    conversationDigestSchedule: {
      findUnique: (...args: unknown[]) => mockState.scheduleFindUnique(...args),
      upsert: (...args: unknown[]) => mockState.scheduleUpsert(...args),
    },
    chatbotClient: { findUnique: (...args: unknown[]) => mockState.findUniqueClient(...args) },
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
  mockState.scheduleFindUnique.mockReset().mockResolvedValue(null);
  mockState.scheduleUpsert.mockReset().mockResolvedValue({
    enabled: true,
    preset: 'morning_noon_evening',
    intervalHours: null,
    timezone: 'Europe/Madrid',
    lastGeneratedAt: null,
  });
  mockState.findUniqueClient.mockReset().mockResolvedValue({ tenantId: 'tenant_1' });
  mockState.isDatabaseConfigured = true;
});

describe('GET /api/portal/conversation-digests/schedule', () => {
  it('401s without a real session', async () => {
    mockState.getSession.mockResolvedValue(SESSION_DENIED);
    const { GET } = await import('@/app/api/portal/conversation-digests/schedule/route');
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('403s when the client has no active chatbot product', async () => {
    mockState.isProductContracted.mockResolvedValue(false);
    const { GET } = await import('@/app/api/portal/conversation-digests/schedule/route');
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it('returns sensible defaults when no schedule row exists yet', async () => {
    const { GET } = await import('@/app/api/portal/conversation-digests/schedule/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schedule).toEqual({
      enabled: false,
      preset: 'morning_noon_evening',
      intervalHours: null,
      timezone: 'Europe/Madrid',
      lastGeneratedAt: null,
    });
  });

  it('returns the persisted schedule when one exists', async () => {
    mockState.scheduleFindUnique.mockResolvedValue({
      enabled: true,
      preset: 'custom_interval',
      intervalHours: 6,
      timezone: 'Europe/Madrid',
      lastGeneratedAt: new Date('2026-08-19T09:00:00Z'),
    });
    const { GET } = await import('@/app/api/portal/conversation-digests/schedule/route');
    const res = await GET();
    const body = await res.json();
    expect(body.schedule).toEqual({
      enabled: true,
      preset: 'custom_interval',
      intervalHours: 6,
      timezone: 'Europe/Madrid',
      lastGeneratedAt: '2026-08-19T09:00:00.000Z',
    });
  });
});

describe('PATCH /api/portal/conversation-digests/schedule', () => {
  it('401s without a real session', async () => {
    mockState.getSession.mockResolvedValue(SESSION_DENIED);
    const { PATCH } = await import('@/app/api/portal/conversation-digests/schedule/route');
    const res = await PATCH(jsonRequest({ enabled: true, preset: 'morning_noon_evening' }));
    expect(res.status).toBe(401);
  });

  it('403s when the client has no active chatbot product', async () => {
    mockState.isProductContracted.mockResolvedValue(false);
    const { PATCH } = await import('@/app/api/portal/conversation-digests/schedule/route');
    const res = await PATCH(jsonRequest({ enabled: true, preset: 'morning_noon_evening' }));
    expect(res.status).toBe(403);
  });

  it('400s on an invalid preset', async () => {
    const { PATCH } = await import('@/app/api/portal/conversation-digests/schedule/route');
    const res = await PATCH(jsonRequest({ enabled: true, preset: 'whenever' }));
    expect(res.status).toBe(400);
  });

  it('400s when preset is custom_interval but intervalHours is missing', async () => {
    const { PATCH } = await import('@/app/api/portal/conversation-digests/schedule/route');
    const res = await PATCH(jsonRequest({ enabled: true, preset: 'custom_interval' }));
    expect(res.status).toBe(400);
    expect(mockState.scheduleUpsert).not.toHaveBeenCalled();
  });

  it('upserts the schedule, nulling intervalHours for the morning_noon_evening preset', async () => {
    const { PATCH } = await import('@/app/api/portal/conversation-digests/schedule/route');
    const res = await PATCH(jsonRequest({ enabled: true, preset: 'morning_noon_evening', intervalHours: 4 }));
    expect(res.status).toBe(200);
    expect(mockState.scheduleUpsert).toHaveBeenCalledWith({
      where: { clientId: 'client_1' },
      update: { enabled: true, preset: 'morning_noon_evening', intervalHours: null, timezone: 'Europe/Madrid' },
      create: expect.objectContaining({ clientId: 'client_1', tenantId: 'tenant_1', enabled: true, intervalHours: null }),
    });
  });

  it('preserves intervalHours for the custom_interval preset', async () => {
    const { PATCH } = await import('@/app/api/portal/conversation-digests/schedule/route');
    await PATCH(jsonRequest({ enabled: true, preset: 'custom_interval', intervalHours: 6 }));
    expect(mockState.scheduleUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ intervalHours: 6 }) }),
    );
  });
});
