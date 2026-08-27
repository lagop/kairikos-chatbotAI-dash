// =============================================================================
// SEO con IA, Fase B — unit tests for GET /api/cron/sync-seo-search-console.
//
// Covers: the CRON_SECRET bearer-token gate (same convention as every
// other /api/cron/* route) and the isDatabaseConfigured guard.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  syncAllDueConnections: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
}));

vi.mock('@/lib/seo-search-console-sync', () => ({
  syncAllDueConnections: (...args: unknown[]) => mockState.syncAllDueConnections(...args),
}));

function makeRequest(headers: Record<string, string> = {}) {
  return {
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.syncAllDueConnections.mockReset().mockResolvedValue({ swept: 2, synced: 1 });
  process.env.CRON_SECRET = 'test_cron_secret';
});

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe('GET /api/cron/sync-seo-search-console', () => {
  it('401s when CRON_SECRET is not configured on the server', async () => {
    delete process.env.CRON_SECRET;
    const { GET } = await import('@/app/api/cron/sync-seo-search-console/route');
    const res = await GET(makeRequest({ authorization: 'Bearer whatever' }));
    expect(res.status).toBe(401);
    expect(mockState.syncAllDueConnections).not.toHaveBeenCalled();
  });

  it('401s when the bearer token does not match', async () => {
    const { GET } = await import('@/app/api/cron/sync-seo-search-console/route');
    const res = await GET(makeRequest({ authorization: 'Bearer wrong' }));
    expect(res.status).toBe(401);
  });

  it('401s when there is no authorization header at all', async () => {
    const { GET } = await import('@/app/api/cron/sync-seo-search-console/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('503s when the database is not configured', async () => {
    mockState.isDatabaseConfigured = false;
    const { GET } = await import('@/app/api/cron/sync-seo-search-console/route');
    const res = await GET(makeRequest({ authorization: 'Bearer test_cron_secret' }));
    expect(res.status).toBe(503);
  });

  it('runs the sweep and returns its result on a valid request', async () => {
    const { GET } = await import('@/app/api/cron/sync-seo-search-console/route');
    const res = await GET(makeRequest({ authorization: 'Bearer test_cron_secret' }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ swept: 2, synced: 1 });
  });
});
