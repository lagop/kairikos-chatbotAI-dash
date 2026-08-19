// =============================================================================
// WP: conexión de canales — unit tests for GET /api/cron/sync-channel-webhooks.
// Same auth/config gating pattern as sync-google-reviews-routes.test.ts's
// cron block.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  retryPendingChannelWebhooks: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
}));

vi.mock('@/lib/channel-webhook', () => ({
  retryPendingChannelWebhooks: (...args: unknown[]) => mockState.retryPendingChannelWebhooks(...args),
}));

function makeRequest(authHeader: string | null) {
  return {
    headers: { get: (name: string) => (name === 'authorization' ? authHeader : null) },
  } as unknown as NextRequest;
}

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.retryPendingChannelWebhooks
    .mockReset()
    .mockResolvedValue({ scanned: 2, delivered: 1, stillFailed: 1, skippedNotConfigured: false });
  process.env.CRON_SECRET = 'secret_123';
});

describe('GET /api/cron/sync-channel-webhooks', () => {
  it('401s without CRON_SECRET configured', async () => {
    delete process.env.CRON_SECRET;
    const { GET } = await import('@/app/api/cron/sync-channel-webhooks/route');
    const res = await GET(makeRequest('Bearer whatever'));
    expect(res.status).toBe(401);
  });

  it('401s when the Authorization header does not match CRON_SECRET', async () => {
    const { GET } = await import('@/app/api/cron/sync-channel-webhooks/route');
    const res = await GET(makeRequest('Bearer wrong'));
    expect(res.status).toBe(401);
    expect(mockState.retryPendingChannelWebhooks).not.toHaveBeenCalled();
  });

  it('retries pending deliveries when the secret matches', async () => {
    const { GET } = await import('@/app/api/cron/sync-channel-webhooks/route');
    const res = await GET(makeRequest('Bearer secret_123'));
    const body = await res.clone().json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ scanned: 2, delivered: 1, stillFailed: 1, skippedNotConfigured: false });
  });

  it('503s when the database is not configured', async () => {
    mockState.isDatabaseConfigured = false;
    const { GET } = await import('@/app/api/cron/sync-channel-webhooks/route');
    const res = await GET(makeRequest('Bearer secret_123'));
    expect(res.status).toBe(503);
    expect(mockState.retryPendingChannelWebhooks).not.toHaveBeenCalled();
  });
});
