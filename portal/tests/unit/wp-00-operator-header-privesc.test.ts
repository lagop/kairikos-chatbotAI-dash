// =============================================================================
// WP-00 (P0 hotfix) — regression tests for the operator-header privilege
// escalation.
//
// Before this fix, `authenticateRequest()` in src/lib/api-auth.ts derived
// `isOperator` from the client-controlled `x-kairikos-operator` request
// header. Any caller holding a valid client bearer token could add that
// header and reach operator-only admin routes — including setting any
// client's password.
//
// Two layers are pinned here:
//   1. `authenticateRequest()` itself never returns `isOperator: true` for
//      an ordinary client token, no matter what `x-kairikos-operator` says.
//   2. The admin routes no longer call `authenticateRequest()` at all — they
//      call `authenticateAdminRequest()` (operator session cookie or the
//      `x-kaia-operator-key` shared secret), so the header is structurally
//      irrelevant, not just ignored by convention.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const authenticateAdminRequest = vi.fn();
const findFirstClientUser = vi.fn();
const userUpdate = vi.fn();
const hashPassword = vi.fn();

vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...args: unknown[]) => authenticateAdminRequest(...args),
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    chatbotClientUser: { findFirst: (...args: unknown[]) => findFirstClientUser(...args) },
    user: { update: (...args: unknown[]) => userUpdate(...args) },
  },
  isDatabaseConfigured: true,
}));
vi.mock('@/lib/operator-crypto', () => ({
  hashPassword: (...args: unknown[]) => hashPassword(...args),
  InMemoryRateLimiter: class {
    check() {
      return true;
    }
  },
}));

function headerMap(headers: Record<string, string>) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => map.get(name.toLowerCase()) ?? null };
}

describe('authenticateRequest() — x-kairikos-operator no longer grants isOperator', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NODE_ENV = 'test';
  });

  function makeReq(headers: Record<string, string>) {
    return { headers: headerMap(headers) } as unknown as Parameters<
      typeof import('@/lib/api-auth').authenticateRequest
    >[0];
  }

  it('a valid client bearer token + x-kairikos-operator: 1 does NOT yield isOperator: true', async () => {
    const { authenticateRequest } = await import('@/lib/api-auth');
    const result = await authenticateRequest(
      makeReq({
        authorization: 'Bearer some-random-client-token-12345',
        'x-kairikos-operator': '1',
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.isOperator).not.toBe(true);
  });

  it('the operator-dev backdoor still works in non-production dev-mock mode', async () => {
    process.env.NODE_ENV = 'test';
    const { authenticateRequest } = await import('@/lib/api-auth');
    const result = await authenticateRequest(makeReq({ authorization: 'Bearer operator-dev' }));
    expect(result.ok).toBe(true);
    expect(result.isOperator).toBe(true);
  });

  it('the operator-dev backdoor is unreachable when NODE_ENV is production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { authenticateRequest } = await import('@/lib/api-auth');
    const result = await authenticateRequest(makeReq({ authorization: 'Bearer operator-dev' }));
    expect(result.ok).toBe(true);
    expect(result.isOperator).not.toBe(true);
    vi.unstubAllEnvs();
  });
});

describe('POST /api/admin/portal/clients/[id]/password — 403 without a real admin session', () => {
  beforeEach(() => {
    authenticateAdminRequest.mockReset();
    findFirstClientUser.mockReset();
    userUpdate.mockReset();
    hashPassword.mockReset();
  });

  function makeRequest(headers: Record<string, string>, body: unknown) {
    return {
      headers: headerMap(headers),
      json: async () => body,
    } as unknown as Parameters<typeof import('@/app/api/admin/portal/clients/[id]/password/route').POST>[0];
  }

  it('a spoofed client bearer + x-kairikos-operator: 1 is rejected with 403 (regression: WP-00)', async () => {
    // This is the exact repro from the audit: a valid client bearer token
    // plus the header that used to grant operator access. The route now
    // asks authenticateAdminRequest() — which knows nothing about that
    // header — and it correctly reports "not an operator".
    authenticateAdminRequest.mockResolvedValueOnce({ ok: false });

    const { POST } = await import('@/app/api/admin/portal/clients/[id]/password/route');
    const res = await POST(
      makeRequest(
        { authorization: 'Bearer some-real-client-token', 'x-kairikos-operator': '1' },
        { email: 'client@example.com', password: 'correct horse battery staple' },
      ),
      { params: { id: 'client_1' } },
    );

    expect(res.status).toBe(403);
    const body = await res.clone().json();
    expect(body.error).toBe('forbidden');
    expect(findFirstClientUser).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it('a real operator session is accepted regardless of x-kairikos-operator', async () => {
    authenticateAdminRequest.mockResolvedValueOnce({ ok: true, sessionId: 's1', operatorId: 'op_1' });
    findFirstClientUser.mockResolvedValueOnce({ id: 'ccu_1', userId: 'user_1' });
    hashPassword.mockResolvedValueOnce('argon2$hashed');
    userUpdate.mockResolvedValueOnce({ id: 'user_1' });

    const { POST } = await import('@/app/api/admin/portal/clients/[id]/password/route');
    const res = await POST(
      makeRequest(
        { authorization: 'Bearer irrelevant-here' },
        { email: 'client@example.com', password: 'correct horse battery staple' },
      ),
      { params: { id: 'client_1' } },
    );

    expect(res.status).toBe(200);
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: 'user_1' },
      data: { passwordHash: 'argon2$hashed', passwordSetAt: expect.any(Date) },
    });
  });
});
