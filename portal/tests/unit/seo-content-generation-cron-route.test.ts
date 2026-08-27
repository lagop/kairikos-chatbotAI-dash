// =============================================================================
// SEO con IA, Fase C — unit tests for GET /api/cron/generate-seo-content.
//
// Covers: the CRON_SECRET bearer-token gate and the isDatabaseConfigured
// guard, same convention as seo-search-console-cron-route.test.ts.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  sweepDueProfiles: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {},
}));

vi.mock('@/lib/seo-content-generation', () => ({
  sweepDueProfiles: (...args: unknown[]) => mockState.sweepDueProfiles(...args),
}));

function makeRequest(headers: Record<string, string> = {}) {
  return {
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.sweepDueProfiles.mockReset().mockResolvedValue({ processed: 3, requested: 2, deliveryFailed: 1 });
  process.env.CRON_SECRET = 'test_cron_secret';
});

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe('GET /api/cron/generate-seo-content', () => {
  it('401s when CRON_SECRET is not configured on the server', async () => {
    delete process.env.CRON_SECRET;
    const { GET } = await import('@/app/api/cron/generate-seo-content/route');
    const res = await GET(makeRequest({ authorization: 'Bearer whatever' }));
    expect(res.status).toBe(401);
    expect(mockState.sweepDueProfiles).not.toHaveBeenCalled();
  });

  it('401s when the bearer token does not match', async () => {
    const { GET } = await import('@/app/api/cron/generate-seo-content/route');
    const res = await GET(makeRequest({ authorization: 'Bearer wrong' }));
    expect(res.status).toBe(401);
  });

  it('503s when the database is not configured', async () => {
    mockState.isDatabaseConfigured = false;
    const { GET } = await import('@/app/api/cron/generate-seo-content/route');
    const res = await GET(makeRequest({ authorization: 'Bearer test_cron_secret' }));
    expect(res.status).toBe(503);
  });

  it('runs the sweep and returns its result on a valid request', async () => {
    const { GET } = await import('@/app/api/cron/generate-seo-content/route');
    const res = await GET(makeRequest({ authorization: 'Bearer test_cron_secret' }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ processed: 3, requested: 2, deliveryFailed: 1 });
  });
});
