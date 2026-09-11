// =============================================================================
// POST /api/public/verify-email (WP-31)
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  verifyEmailToken: vi.fn(),
}));

vi.mock('@/lib/self-serve-onboarding', () => ({
  verifyEmailToken: (...args: unknown[]) => mockState.verifyEmailToken(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {},
  isDatabaseConfigured: true,
}));

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof import('@/app/api/public/verify-email/route').POST>[0];
}

beforeEach(() => {
  mockState.verifyEmailToken.mockReset().mockResolvedValue({ ok: true });
});

describe('POST /api/public/verify-email', () => {
  it('400s on an invalid body', async () => {
    const { POST } = await import('@/app/api/public/verify-email/route');
    const res = await POST(makeRequest({ email: 'not-an-email', token: 'x' }));
    expect(res.status).toBe(400);
    expect(mockState.verifyEmailToken).not.toHaveBeenCalled();
  });

  it('400s with invalid_or_expired_token when the token does not match', async () => {
    mockState.verifyEmailToken.mockResolvedValueOnce({ ok: false, error: 'invalid_or_expired_token' });
    const { POST } = await import('@/app/api/public/verify-email/route');
    const res = await POST(makeRequest({ email: 'aurora@example.com', token: 'a'.repeat(64) }));
    const body = await res.clone().json();
    expect(res.status).toBe(400);
    expect(body.error).toBe('invalid_or_expired_token');
  });

  it('200s on a valid token', async () => {
    const { POST } = await import('@/app/api/public/verify-email/route');
    const res = await POST(makeRequest({ email: 'aurora@example.com', token: 'a'.repeat(64) }));
    expect(res.status).toBe(200);
    expect(mockState.verifyEmailToken).toHaveBeenCalledWith(expect.anything(), { email: 'aurora@example.com', token: 'a'.repeat(64) });
  });
});
