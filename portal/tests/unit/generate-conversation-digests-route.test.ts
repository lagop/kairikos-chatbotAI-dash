// =============================================================================
// Canales Fase 7 — unit tests for GET /api/cron/generate-conversation-digests.
// Same auth/config gating pattern as sync-channel-webhooks-route.test.ts.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  generateDueDigests: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
}));

vi.mock('@/lib/conversation-digest', () => ({
  generateDueDigests: (...args: unknown[]) => mockState.generateDueDigests(...args),
}));

function makeRequest(authHeader: string | null) {
  return {
    headers: { get: (name: string) => (name === 'authorization' ? authHeader : null) },
  } as unknown as NextRequest;
}

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.generateDueDigests.mockReset().mockResolvedValue({ swept: 3, generated: 1 });
  process.env.CRON_SECRET = 'secret_123';
});

describe('GET /api/cron/generate-conversation-digests', () => {
  it('401s without CRON_SECRET configured', async () => {
    delete process.env.CRON_SECRET;
    const { GET } = await import('@/app/api/cron/generate-conversation-digests/route');
    const res = await GET(makeRequest('Bearer whatever'));
    expect(res.status).toBe(401);
  });

  it('401s when the Authorization header does not match CRON_SECRET', async () => {
    const { GET } = await import('@/app/api/cron/generate-conversation-digests/route');
    const res = await GET(makeRequest('Bearer wrong'));
    expect(res.status).toBe(401);
    expect(mockState.generateDueDigests).not.toHaveBeenCalled();
  });

  it('sweeps due digests when the secret matches', async () => {
    const { GET } = await import('@/app/api/cron/generate-conversation-digests/route');
    const res = await GET(makeRequest('Bearer secret_123'));
    const body = await res.clone().json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ swept: 3, generated: 1 });
  });

  it('503s when the database is not configured', async () => {
    mockState.isDatabaseConfigured = false;
    const { GET } = await import('@/app/api/cron/generate-conversation-digests/route');
    const res = await GET(makeRequest('Bearer secret_123'));
    expect(res.status).toBe(503);
    expect(mockState.generateDueDigests).not.toHaveBeenCalled();
  });
});
