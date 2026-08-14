// =============================================================================
// WP-22a — unit tests for:
//   POST /api/portal/google-business/sync   (client-triggered manual sync)
//   GET  /api/cron/sync-google-reviews      (Vercel Cron sweep)
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  resolveClientFromSession: vi.fn(),
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

vi.mock('@/lib/client-product-access', () => ({
  isProductContracted: (...args: unknown[]) => mockState.isProductContracted(...args),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    googleBusinessConnection: { findFirst: (...args: unknown[]) => mockState.connectionFindFirst(...args) },
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
  mockState.isDatabaseConfigured = true;
  mockState.isProductContracted.mockReset().mockResolvedValue(true);
  mockState.connectionFindFirst.mockReset().mockResolvedValue({ id: 'conn_1', status: 'active', lastSyncAt: null });
  mockState.isSyncDue.mockReset().mockReturnValue(true);
  mockState.syncReviewsForConnection.mockReset().mockResolvedValue({ synced: true, reviewCount: 3 });
  mockState.syncAllDueConnections.mockReset().mockResolvedValue({ swept: 2, synced: 1 });
});

describe('POST /api/portal/google-business/sync', () => {
  function makeRequest() {
    return {} as unknown as NextRequest;
  }

  it('401s when there is no session', async () => {
    mockState.resolveClientFromSession.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/portal/google-business/sync/route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
  });

  it('403s when the client does not have the reviews product contracted', async () => {
    mockState.isProductContracted.mockResolvedValueOnce(false);
    const { POST } = await import('@/app/api/portal/google-business/sync/route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
    expect(mockState.connectionFindFirst).not.toHaveBeenCalled();
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
