// =============================================================================
// GET /api/cron/retention-purge — la ruta solo cablea autenticación y el
// borrado (que tiene su propio test, retention-purge.test.ts). Lo que se
// guarda aquí es que un fallo NO responda 200: si el borrado deja de correr,
// la política de privacidad deja de cumplirse, y eso tiene que salir como
// FAILED en el log del scheduler, no como un OK más.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  runRetentionPurge: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {},
}));

vi.mock('@/lib/retention-purge', () => ({
  runRetentionPurge: (...args: unknown[]) => mockState.runRetentionPurge(...args),
}));

vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));

function makeRequest(headers: Record<string, string> = {}) {
  return {
    headers: new Headers(headers),
  } as unknown as NextRequest;
}

const COUNTS = {
  calculatorLeadsDeleted: 1,
  draftRequestsDeleted: 0,
  ownProspectsDeleted: 0,
  ownProspectsMinimized: 2,
};

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.runRetentionPurge.mockReset().mockResolvedValue(COUNTS);
  process.env.CRON_SECRET = 'test_cron_secret';
});

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe('GET /api/cron/retention-purge', () => {
  it('401 sin el secreto, y no borra nada', async () => {
    const { GET } = await import('@/app/api/cron/retention-purge/route');
    const res = await GET(makeRequest({ authorization: 'Bearer otro' }));
    expect(res.status).toBe(401);
    expect(mockState.runRetentionPurge).not.toHaveBeenCalled();
  });

  it('503 sin base de datos', async () => {
    mockState.isDatabaseConfigured = false;
    const { GET } = await import('@/app/api/cron/retention-purge/route');
    const res = await GET(makeRequest({ authorization: 'Bearer test_cron_secret' }));
    expect(res.status).toBe(503);
  });

  it('devuelve el recuento, que es lo que queda en el log del scheduler', async () => {
    const { GET } = await import('@/app/api/cron/retention-purge/route');
    const res = await GET(makeRequest({ authorization: 'Bearer test_cron_secret' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ...COUNTS });
  });

  it('un fallo responde 500, no un 200 con ok:false', async () => {
    mockState.runRetentionPurge.mockRejectedValue(new Error('db caída'));
    const { GET } = await import('@/app/api/cron/retention-purge/route');
    const res = await GET(makeRequest({ authorization: 'Bearer test_cron_secret' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'db caída' });
  });
});
