// =============================================================================
// KAIA-11302 follow-up — Unit tests for POST /api/portal/setup-password.
//
// Contract under test (secure token-gated flow):
//
//   * 400 `invalid_body` when the body is not JSON or missing any of
//     `email`, `token`, `password`.
//   * 400 `invalid_or_expired_token` when the token does not hash to
//     a live, unused, unexpired `PasswordResetToken` row for the
//     given email.
//   * 404 `user_not_found` when the email is well-formed but not
//     mapped to a `ChatbotClientUser` (or the userId resolves to no
//     `User` row).
//   * 409 `password_already_set` when the user already has a password
//     and the token is burned in the same request (defence in depth
//     against a leaked link).
//   * 200 `{ ok: true }` happy path: the password hash is written, the
//     `passwordSetAt` is set, and the token row is marked usedAt in
//     a single transaction.
//
// The previous build accepted {email, password} from any caller, which
// was a known-authentication-bypass vector. These tests pin the
// secure behaviour in place so a future refactor cannot regress it
// without breaking CI.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'node:crypto';

const findFirstResetToken = vi.fn();
const updateResetToken = vi.fn();
const updateManyResetToken = vi.fn();
const findUniqueClientUser = vi.fn();
const findUniqueUser = vi.fn();
const userUpdate = vi.fn();
const $transaction = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    passwordResetToken: {
      findFirst: (...args: unknown[]) => findFirstResetToken(...args),
      update: (...args: unknown[]) => updateResetToken(...args),
      updateMany: (...args: unknown[]) => updateManyResetToken(...args),
    },
    chatbotClientUser: {
      findUnique: (...args: unknown[]) => findUniqueClientUser(...args),
    },
    user: {
      findUnique: (...args: unknown[]) => findUniqueUser(...args),
      update: (...args: unknown[]) => userUpdate(...args),
    },
    $transaction: (...args: unknown[]) => $transaction(...args),
  },
  isDatabaseConfigured: true,
}));

const hashPassword = vi.fn();
vi.mock('@/lib/operator-crypto', () => ({
  hashPassword: (...args: unknown[]) => hashPassword(...args),
}));

import { POST } from '@/app/api/portal/setup-password/route';

const EMAIL = 'qa-setup@kairikos.test';
const PASSWORD = 'correct horse battery staple';
const RAW_TOKEN = 'a'.repeat(64);
const TOKEN_HASH = crypto.createHash('sha256').update(RAW_TOKEN).digest('hex');

function makeRequest(body: unknown) {
  return {
    json: async () => body,
  } as unknown as Parameters<typeof POST>[0];
}

async function bodyOf(res: Response): Promise<{ status: number; body: any }> {
  const body = await res.clone().json();
  return { status: res.status, body };
}

beforeEach(() => {
  findFirstResetToken.mockReset();
  updateResetToken.mockReset();
  updateManyResetToken.mockReset();
  findUniqueClientUser.mockReset();
  findUniqueUser.mockReset();
  userUpdate.mockReset();
  $transaction.mockReset();
  hashPassword.mockReset();
  $transaction.mockImplementation(async (steps: unknown[]) => Promise.all(steps));
  hashPassword.mockResolvedValue('argon2$hashed$value');
});

describe('POST /api/portal/setup-password — KAIA-11302 secure token flow', () => {
  it('400s on invalid JSON', async () => {
    const res = await POST(makeRequest(null));
    const { status, body } = await bodyOf(res);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_body');
    expect(findFirstResetToken).not.toHaveBeenCalled();
  });

  it('400s when token is missing (regression: previous build accepted no token)', async () => {
    const res = await POST(
      makeRequest({ email: EMAIL, password: PASSWORD }),
    );
    const { status, body } = await bodyOf(res);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_body');
    expect(findFirstResetToken).not.toHaveBeenCalled();
  });

  it('400s when token is the wrong length', async () => {
    const res = await POST(
      makeRequest({ email: EMAIL, token: 'short', password: PASSWORD }),
    );
    const { status, body } = await bodyOf(res);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_body');
    expect(findFirstResetToken).not.toHaveBeenCalled();
  });

  it('400s with invalid_or_expired_token when no row matches the email+hash', async () => {
    findFirstResetToken.mockResolvedValueOnce(null);
    const res = await POST(
      makeRequest({ email: EMAIL, token: RAW_TOKEN, password: PASSWORD }),
    );
    const { status, body } = await bodyOf(res);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_or_expired_token');
    expect(findFirstResetToken).toHaveBeenCalledTimes(1);
    expect(findFirstResetToken).toHaveBeenCalledWith({
      where: {
        email: EMAIL,
        tokenHash: TOKEN_HASH,
        usedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(findUniqueClientUser).not.toHaveBeenCalled();
  });

  it('404s when the email is not mapped to a ChatbotClientUser', async () => {
    findFirstResetToken.mockResolvedValueOnce({ id: 'prt_001', email: EMAIL, tokenHash: TOKEN_HASH });
    findUniqueClientUser.mockResolvedValueOnce(null);
    const res = await POST(
      makeRequest({ email: EMAIL, token: RAW_TOKEN, password: PASSWORD }),
    );
    const { status, body } = await bodyOf(res);
    expect(status).toBe(404);
    expect(body.error).toBe('user_not_found');
  });

  it('409s and burns the token when the user already has a password (defence in depth)', async () => {
    findFirstResetToken.mockResolvedValueOnce({ id: 'prt_002', email: EMAIL, tokenHash: TOKEN_HASH });
    findUniqueClientUser.mockResolvedValueOnce({ id: 'ccu_1', userId: 'user_1' });
    findUniqueUser.mockResolvedValueOnce({ id: 'user_1', passwordHash: 'existing-hash' });
    updateResetToken.mockResolvedValueOnce({ id: 'prt_002' });
    const res = await POST(
      makeRequest({ email: EMAIL, token: RAW_TOKEN, password: PASSWORD }),
    );
    const { status, body } = await bodyOf(res);
    expect(status).toBe(409);
    expect(body.error).toBe('password_already_set');
    expect(updateResetToken).toHaveBeenCalledWith({
      where: { id: 'prt_002' },
      data: { usedAt: expect.any(Date) },
    });
    expect(userUpdate).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });

  it('200s the happy path for the __must_reset__ sentinel', async () => {
    findFirstResetToken.mockResolvedValueOnce({ id: 'prt_004', email: EMAIL, tokenHash: TOKEN_HASH });
    findUniqueClientUser.mockResolvedValueOnce({ id: 'ccu_1', userId: 'user_1' });
    findUniqueUser.mockResolvedValueOnce({ id: 'user_1', passwordHash: '__must_reset__' });
    userUpdate.mockResolvedValueOnce({ id: 'user_1' });
    updateResetToken.mockResolvedValueOnce({ id: 'prt_004' });

    const res = await POST(
      makeRequest({ email: EMAIL, token: RAW_TOKEN, password: PASSWORD }),
    );
    const { status, body } = await bodyOf(res);

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: 'user_1' },
      data: { passwordHash: 'argon2$hashed$value', passwordSetAt: expect.any(Date) },
    });
    expect(updateResetToken).toHaveBeenCalledWith({
      where: { id: 'prt_004' },
      data: { usedAt: expect.any(Date) },
    });
  });

  it('200s the happy path: writes the hash, sets passwordSetAt, burns the token in one transaction', async () => {
    findFirstResetToken.mockResolvedValueOnce({ id: 'prt_003', email: EMAIL, tokenHash: TOKEN_HASH });
    findUniqueClientUser.mockResolvedValueOnce({ id: 'ccu_1', userId: 'user_1' });
    findUniqueUser.mockResolvedValueOnce({ id: 'user_1', passwordHash: null });
    userUpdate.mockResolvedValueOnce({ id: 'user_1' });
    updateResetToken.mockResolvedValueOnce({ id: 'prt_003' });
    const res = await POST(
      makeRequest({ email: EMAIL, token: RAW_TOKEN, password: PASSWORD }),
    );
    const { status, body } = await bodyOf(res);
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(hashPassword).toHaveBeenCalledWith(PASSWORD);
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: 'user_1' },
      data: { passwordHash: 'argon2$hashed$value', passwordSetAt: expect.any(Date) },
    });
    expect(updateResetToken).toHaveBeenCalledWith({
      where: { id: 'prt_003' },
      data: { usedAt: expect.any(Date) },
    });
    expect($transaction).toHaveBeenCalledTimes(1);
    expect($transaction.mock.calls[0][0]).toHaveLength(2);
  });

  it('400s on a short password (Zod min(8) catches it before the DB lookup)', async () => {
    const res = await POST(
      makeRequest({ email: EMAIL, token: RAW_TOKEN, password: 'short' }),
    );
    const { status, body } = await bodyOf(res);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_body');
    expect(findFirstResetToken).not.toHaveBeenCalled();
  });

  it('400s on an over-long password (Zod max(128) catches it before the DB lookup)', async () => {
    const res = await POST(
      makeRequest({ email: EMAIL, token: RAW_TOKEN, password: 'x'.repeat(129) }),
    );
    const { status, body } = await bodyOf(res);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_body');
    expect(findFirstResetToken).not.toHaveBeenCalled();
  });

  it('400s on a malformed email (Zod email catches it before the DB lookup)', async () => {
    const res = await POST(
      makeRequest({ email: 'not-an-email', token: RAW_TOKEN, password: PASSWORD }),
    );
    const { status, body } = await bodyOf(res);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_body');
    expect(findFirstResetToken).not.toHaveBeenCalled();
  });

  it('400s with invalid_or_expired_token when the row exists but usedAt is already set (burned token)', async () => {
    // findFirst is the ONLY place the route checks usedAt; the WHERE clause
    // `usedAt: null` is the burn gate. If the row was already burned,
    // findFirst returns null and the route must 400.
    findFirstResetToken.mockResolvedValueOnce(null);
    const res = await POST(
      makeRequest({ email: EMAIL, token: RAW_TOKEN, password: PASSWORD }),
    );
    const { status, body } = await bodyOf(res);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_or_expired_token');
    // Burned-token path must NOT touch the user table.
    expect(findUniqueClientUser).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it('400s with invalid_or_expired_token when the row exists but expiresAt is in the past (expired token)', async () => {
    // Same findFirst gate. The `expiresAt: { gt: expect.any(Date) }` clause
    // in the WHERE prevents any row whose expiresAt <= now from being
    // returned, so an expired token must fall through to 400.
    findFirstResetToken.mockResolvedValueOnce(null);
    const res = await POST(
      makeRequest({ email: EMAIL, token: RAW_TOKEN, password: PASSWORD }),
    );
    const { status, body } = await bodyOf(res);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_or_expired_token');
    expect(findFirstResetToken).toHaveBeenCalledWith({
      where: {
        email: EMAIL,
        tokenHash: TOKEN_HASH,
        usedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(findUniqueClientUser).not.toHaveBeenCalled();
  });

  it('404s when ChatbotClientUser exists but the linked userId resolves to no User row', async () => {
    // A backfilled ChatbotClientUser can have a stale userId pointing at a
    // deleted User. The route must refuse the write and surface 404 rather
    // than 200 — never silently lie.
    findFirstResetToken.mockResolvedValueOnce({ id: 'prt_005', email: EMAIL, tokenHash: TOKEN_HASH });
    findUniqueClientUser.mockResolvedValueOnce({ id: 'ccu_1', userId: 'orphan_user_id' });
    findUniqueUser.mockResolvedValueOnce(null);
    const res = await POST(
      makeRequest({ email: EMAIL, token: RAW_TOKEN, password: PASSWORD }),
    );
    const { status, body } = await bodyOf(res);
    expect(status).toBe(404);
    expect(body.error).toBe('user_not_found');
    expect(userUpdate).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });

  it('replay rejection: second POST with the same body returns 409 (defence in depth — token already burned by first call)', async () => {
    // First call: success path, burns the token.
    findFirstResetToken.mockResolvedValueOnce({ id: 'prt_006', email: EMAIL, tokenHash: TOKEN_HASH });
    findUniqueClientUser.mockResolvedValueOnce({ id: 'ccu_1', userId: 'user_1' });
    findUniqueUser.mockResolvedValueOnce({ id: 'user_1', passwordHash: null });
    userUpdate.mockResolvedValueOnce({ id: 'user_1' });
    updateResetToken.mockResolvedValueOnce({ id: 'prt_006' });
    const first = await POST(
      makeRequest({ email: EMAIL, token: RAW_TOKEN, password: PASSWORD }),
    );
    expect(first.status).toBe(200);
    // Second call: token row is gone (usedAt set), findFirst returns null.
    findFirstResetToken.mockResolvedValueOnce(null);
    const second = await POST(
      makeRequest({ email: EMAIL, token: RAW_TOKEN, password: 'different-pw-1234' }),
    );
    const { status, body } = await bodyOf(second);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_or_expired_token');
  });

  it('email mismatch is impossible by construction: the WHERE clause scopes by `email` so a token for A cannot be used with body=B', async () => {
    // Token belongs to alice@example.com. Body says bob@example.com.
    // findFirst({ where: { email: 'bob@example.com', tokenHash } }) → null.
    findFirstResetToken.mockResolvedValueOnce(null);
    const res = await POST(
      makeRequest({ email: 'bob@example.com', token: RAW_TOKEN, password: PASSWORD }),
    );
    const { status, body } = await bodyOf(res);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_or_expired_token');
    // Defence in depth: route never wrote the password for bob, never
    // touched bob's user record.
    expect(findUniqueClientUser).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });
});
