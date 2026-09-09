// =============================================================================
// SEO con IA, Fase 5 — unit tests for GET /api/cron/seo-draft-auto-approve.
// Same convention as every other cron route test. The sweep's own
// behavior lives in seo-draft-auto-approve.test.ts.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  sweepAutoApprovableSeoDrafts: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {},
}));

vi.mock('@/lib/seo-draft-auto-approve', () => ({
  sweepAutoApprovableSeoDrafts: (...args: unknown[]) => mockState.sweepAutoApprovableSeoDrafts(...args),
}));

function makeRequest(headers: Record<string, string> = {}) {
  return {
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.sweepAutoApprovableSeoDrafts
    .mockReset()
    .mockResolvedValue({ due: 1, processed: 1, approved: 1, published: 1, publishFailed: 0, failed: [] });
  process.env.CRON_SECRET = 'test_cron_secret';
});

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe('GET /api/cron/seo-draft-auto-approve', () => {
  it('401s when CRON_SECRET is not configured on the server', async () => {
    delete process.env.CRON_SECRET;
    const { GET } = await import('@/app/api/cron/seo-draft-auto-approve/route');
    const res = await GET(makeRequest({ authorization: 'Bearer whatever' }));
    expect(res.status).toBe(401);
    expect(mockState.sweepAutoApprovableSeoDrafts).not.toHaveBeenCalled();
  });

  it('401s when the bearer token does not match', async () => {
    const { GET } = await import('@/app/api/cron/seo-draft-auto-approve/route');
    const res = await GET(makeRequest({ authorization: 'Bearer wrong' }));
    expect(res.status).toBe(401);
  });

  it('503s when the database is not configured', async () => {
    mockState.isDatabaseConfigured = false;
    const { GET } = await import('@/app/api/cron/seo-draft-auto-approve/route');
    const res = await GET(makeRequest({ authorization: 'Bearer test_cron_secret' }));
    expect(res.status).toBe(503);
    expect(mockState.sweepAutoApprovableSeoDrafts).not.toHaveBeenCalled();
  });

  it('runs the sweep and returns its result on a valid request', async () => {
    const { GET } = await import('@/app/api/cron/seo-draft-auto-approve/route');
    const res = await GET(makeRequest({ authorization: 'Bearer test_cron_secret' }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ due: 1, processed: 1, approved: 1, published: 1, publishFailed: 0, failed: [] });
  });
});
