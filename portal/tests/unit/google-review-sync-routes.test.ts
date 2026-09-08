// =============================================================================
// WP-22a — unit tests for:
//   POST /api/portal/google-business/sync   (client-triggered manual sync)
//   GET  /api/cron/sync-google-reviews      (Vercel Cron sweep)
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  resolveClientFromSession: vi.fn(),
  getSession: vi.fn(),
  isDatabaseConfigured: true,
  isProductContracted: vi.fn(),
  connectionFindFirst: vi.fn(),
  isSyncDue: vi.fn(),
  syncReviewsForConnection: vi.fn(),
  syncAllDueConnections: vi.fn(),
}));

vi.mock('@/lib/portal-session', () => ({
  resolveClientFromSession: (...args: unknown[]) => mockState.resolveClientFromSession(...args),
}));

vi.mock('@/lib/session', () => ({
  getSession: (...args: unknown[]) => mockState.getSession(...args),
}));

vi.mock('@/lib/client-product-access', () => ({
  isProductContracted: (...args: unknown[]) => mockState.isProductContracted(...args),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    googleBusinessConnection: {
      findFirst: (...args: unknown[]) => mockState.connectionFindFirst(...args),
      // Fase 3 — resolveReviewConnection lista para distinguir «un local»
      // de «varios»; estos tests describen un cliente de un solo local, así
      // que devuelve lo mismo que findFirst, envuelto.
      findMany: async (...args: unknown[]) => {
        const one = await mockState.connectionFindFirst(...args);
        return one ? [one] : [];
      },
    },
  },
}));

vi.mock('@/lib/google-review-sync', () => ({
  isSyncDue: (...args: unknown[]) => mockState.isSyncDue(...args),
  syncReviewsForConnection: (...args: unknown[]) => mockState.syncReviewsForConnection(...args),
  syncAllDueConnections: (...args: unknown[]) => mockState.syncAllDueConnections(...args),
}));

const RESOLVED = { clientId: 'client_1', email: 'a@b.com', source: 'database' as const };

beforeEach(() => {
  mockState.resolveClientFromSession.mockReset().mockResolvedValue(RESOLVED);
  mockState.getSession.mockReset().mockResolvedValue({ hasClientAccess: true });
  mockState.isDatabaseConfigured = true;
  mockState.isProductContracted.mockReset().mockResolvedValue(true);
  mockState.connectionFindFirst.mockReset().mockResolvedValue({ id: 'conn_1', status: 'active', lastSyncAt: null });
  mockState.isSyncDue.mockReset().mockReturnValue(true);
  mockState.syncReviewsForConnection.mockReset().mockResolvedValue({ synced: true, reviewCount: 3 });
  mockState.syncAllDueConnections.mockReset().mockResolvedValue({ swept: 2, synced: 1 });
});

describe('POST /api/portal/google-business/sync', () => {
  // Fase 3 — la ruta lee ?connectionId para saber en qué local sincronizar,
  // así que la petición falsa necesita una URL de verdad. Sin parámetro se
  // resuelve el único local del cliente, que es lo que describen estos tests.
  function makeRequest(connectionId?: string) {
    const base = 'https://portal.test/api/portal/google-business/sync';
    const url = connectionId ? `${base}?connectionId=${connectionId}` : base;
    return { url } as unknown as NextRequest;
  }

  it('401s when there is no session', async () => {
    mockState.resolveClientFromSession.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/portal/google-business/sync/route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
  });

  // La puerta de esta ruta es hasGoogleBusinessConnectAccess: 'reviews' O
  // 'recall'. Este test llevaba roto desde que la ruta pasó de comprobar
  // solo 'reviews' a comprobar las dos, porque usaba mockResolvedValueOnce:
  // el helper llama a isProductContracted DOS veces (Promise.all), la
  // primera devolvía false, la segunda el true por defecto, y el OR dejaba
  // pasar. Hacen falta las dos en false para negar el acceso.
  it('403s when the client has neither the reviews nor the recall product', async () => {
    mockState.isProductContracted.mockResolvedValue(false);
    const { POST } = await import('@/app/api/portal/google-business/sync/route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
    expect(mockState.connectionFindFirst).not.toHaveBeenCalled();
  });

  // La mitad de la regla que NADIE probaba, y por eso la deriva pasó
  // desapercibida: un cliente de 'recall' sin 'reviews' también sincroniza,
  // porque su mitad de invitaciones a reseñar depende de esto.
  it('lets a recall-only client through: the gate is reviews OR recall', async () => {
    mockState.isProductContracted.mockImplementation((_p: unknown, _c: unknown, code: string) =>
      Promise.resolve(code === 'recall'),
    );
    const { POST } = await import('@/app/api/portal/google-business/sync/route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
  });

  it('404s when the client has no active connection', async () => {
    mockState.connectionFindFirst.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/portal/google-business/sync/route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(404);
  });

  it('429s when synced too recently', async () => {
    mockState.isSyncDue.mockReturnValueOnce(false);
    const { POST } = await import('@/app/api/portal/google-business/sync/route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(429);
    expect(mockState.syncReviewsForConnection).not.toHaveBeenCalled();
  });

  it('syncs and returns the result on success', async () => {
    const { POST } = await import('@/app/api/portal/google-business/sync/route');
    const res = await POST(makeRequest());
    const body = await res.clone().json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ synced: true, reviewCount: 3 });
  });
});

describe('GET /api/cron/sync-google-reviews', () => {
  function makeRequest(authHeader: string | null) {
    return {
      headers: { get: (name: string) => (name === 'authorization' ? authHeader : null) },
    } as unknown as NextRequest;
  }

  beforeEach(() => {
    process.env.CRON_SECRET = 'secret_123';
  });

  it('401s without CRON_SECRET configured', async () => {
    delete process.env.CRON_SECRET;
    const { GET } = await import('@/app/api/cron/sync-google-reviews/route');
    const res = await GET(makeRequest('Bearer whatever'));
    expect(res.status).toBe(401);
  });

  it('401s when the Authorization header does not match CRON_SECRET', async () => {
    const { GET } = await import('@/app/api/cron/sync-google-reviews/route');
    const res = await GET(makeRequest('Bearer wrong'));
    expect(res.status).toBe(401);
    expect(mockState.syncAllDueConnections).not.toHaveBeenCalled();
  });

  it('sweeps all due connections when the secret matches', async () => {
    const { GET } = await import('@/app/api/cron/sync-google-reviews/route');
    const res = await GET(makeRequest('Bearer secret_123'));
    const body = await res.clone().json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ swept: 2, synced: 1 });
  });

  it('503s when the database is not configured', async () => {
    mockState.isDatabaseConfigured = false;
    const { GET } = await import('@/app/api/cron/sync-google-reviews/route');
    const res = await GET(makeRequest('Bearer secret_123'));
    expect(res.status).toBe(503);
  });
});
