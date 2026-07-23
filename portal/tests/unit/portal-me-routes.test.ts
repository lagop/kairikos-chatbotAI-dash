// =============================================================================
// KAIA-3922 — Unit tests for the PATCH /api/portal/me and
// POST /api/portal/me/password routes (KAIA-3921 contract).
//
// Contract under test:
//
//   PATCH /api/portal/me
//     * 401 when no session
//     * 400 + { error: 'invalid_body', detail } on Zod failures and
//       empty body / no allowlisted fields
//     * 200 with the updated ClientProfile on success
//     * clientId is NEVER read from the body — only from the session
//     * Refuses to honor unknown fields via .strict()
//
//   POST /api/portal/me/password
//     * 401 when no session
//     * 400 + { error: 'invalid', detail } on Zod failures
//     * 503 when the DB is not configured
//     * 404 when the session email does not resolve to a User
//     * 409 when the user has not yet completed setup-password or is in
//       the __must_reset__ backfill state
//     * 401 when the supplied current password does not verify
//     * 200 + { ok: true, reauth_required: true } on success; updates
//       passwordHash, sets passwordSetAt, and burns open reset tokens
//     * The user update and the reset-token burn run inside one
//       prisma.$transaction so a partial failure cannot leave a
//       half-rotated credential in place
//
// Prisma, operator-crypto, and portal-session are fully mocked. The
// tests never touch a real database or NextAuth instance.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveClientFromSession = vi.fn();
const findUnique = vi.fn();
const update = vi.fn();
const updateMany = vi.fn();
const transaction = vi.fn();
const verifyPassword = vi.fn();
const hashPassword = vi.fn();

vi.mock('@/lib/portal-session', () => ({
  resolveClientFromSession: (...args: unknown[]) => resolveClientFromSession(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    chatbotClient: {
      findUnique: (...args: unknown[]) => findUnique(...args),
      update: (...args: unknown[]) => update(...args),
    },
    chatbotClientUser: {
      findUnique: (...args: unknown[]) => findUnique(...args),
    },
    user: {
      findUnique: (...args: unknown[]) => findUnique(...args),
      update: (...args: unknown[]) => update(...args),
    },
    passwordResetToken: {
      updateMany: (...args: unknown[]) => updateMany(...args),
    },
    $transaction: (...args: unknown[]) => transaction(...args),
  },
  isDatabaseConfigured: true,
}));

vi.mock('@/lib/operator-crypto', () => ({
  verifyPassword: (...args: unknown[]) => verifyPassword(...args),
  hashPassword: (...args: unknown[]) => hashPassword(...args),
  InMemoryRateLimiter: class {
    private hits = 0;
    constructor(_windowMs: number) {}
    check(_key: string, _limit: number) {
      this.hits += 1;
      return true;
    }
  },
}));

import { POST as changePassword } from '@/app/api/portal/me/password/route';
import { PATCH as updateProfile, GET as getProfile } from '@/app/api/portal/me/route';

const KNOWN_CLIENT_ID = 'client_aurora_001';
const KNOWN_EMAIL = 'aurora@example.com';
const KNOWN_USER_ID = 'user_aurora_001';

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return {
    json: async () => body,
    headers: {
      get: (name: string) => {
        const lower = name.toLowerCase();
        for (const [k, v] of Object.entries(headers)) {
          if (k.toLowerCase() === lower) return v;
        }
        return null;
      },
    },
  } as unknown as Parameters<typeof changePassword>[0];
}

beforeEach(() => {
  resolveClientFromSession.mockReset();
  findUnique.mockReset();
  update.mockReset();
  updateMany.mockReset();
  transaction.mockReset();
  verifyPassword.mockReset();
  hashPassword.mockReset();
  // Default: $transaction resolves each op in order, mirroring Prisma.
  transaction.mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops));
});

describe('GET /api/portal/me', () => {
  it('returns 401 when no session', async () => {
    resolveClientFromSession.mockResolvedValueOnce(null);
    const res = await getProfile(makeRequest(null));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('returns the serialized ClientProfile row from the database', async () => {
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: KNOWN_CLIENT_ID,
      email: KNOWN_EMAIL,
      source: 'database',
    });
    findUnique.mockResolvedValueOnce({
      id: KNOWN_CLIENT_ID,
      email: KNOWN_EMAIL,
      name: 'Aurora Owner',
      companyName: 'Aurora S.L.',
      tier: 'pro',
      stripeCustomerId: 'cus_aurora',
      goLiveAt: new Date('2026-05-29T09:00:00.000Z'),
      createdAt: new Date('2026-05-22T10:00:00.000Z'),
      updatedAt: new Date('2026-05-30T09:00:00.000Z'),
    });

    const res = await getProfile(makeRequest(null));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      id: KNOWN_CLIENT_ID,
      companyName: 'Aurora S.L.',
      primaryContactEmail: KNOWN_EMAIL,
      tier: 'pro',
      onboardingStatus: 'live',
      contactName: 'Aurora Owner',
    });
  });

  it('returns 404 when the resolved client row does not exist', async () => {
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: KNOWN_CLIENT_ID,
      email: KNOWN_EMAIL,
      source: 'database',
    });
    findUnique.mockResolvedValueOnce(null);

    const res = await getProfile(makeRequest(null));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});

describe('PATCH /api/portal/me', () => {
  it('returns 401 when no session', async () => {
    resolveClientFromSession.mockResolvedValueOnce(null);
    const res = await updateProfile(makeRequest({ contactName: 'Aurora' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('returns 400 + detail when the body is not parseable JSON', async () => {
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: KNOWN_CLIENT_ID,
      email: KNOWN_EMAIL,
      source: 'database',
    });
    const req = {
      json: async () => {
        throw new SyntaxError('bad json');
      },
      headers: { get: () => null },
    } as unknown as Parameters<typeof updateProfile>[0];
    const res = await updateProfile(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
    expect(typeof body.detail).toBe('string');
    expect(findUnique).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('returns 400 + detail when the body has no allowlisted fields', async () => {
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: KNOWN_CLIENT_ID,
      email: KNOWN_EMAIL,
      source: 'database',
    });
    const res = await updateProfile(makeRequest({}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
    expect(typeof body.detail).toBe('string');
  });

  it('returns 400 + detail when an unknown field is supplied (strict mode)', async () => {
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: KNOWN_CLIENT_ID,
      email: KNOWN_EMAIL,
      source: 'database',
    });
    const res = await updateProfile(
      makeRequest({ contactName: 'Aurora', tier: 'premium' }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
    expect(typeof body.detail).toBe('string');
    expect(update).not.toHaveBeenCalled();
  });

  it('returns 400 + Spanish detail when the contact name is empty', async () => {
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: KNOWN_CLIENT_ID,
      email: KNOWN_EMAIL,
      source: 'database',
    });
    const res = await updateProfile(makeRequest({ contactName: '' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
    expect(body.detail.toLowerCase()).toContain('nombre');
  });

  it('updates contactName via the legacy alias and persists to session clientId', async () => {
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: KNOWN_CLIENT_ID,
      email: KNOWN_EMAIL,
      source: 'database',
    });
    update.mockResolvedValueOnce({
      id: KNOWN_CLIENT_ID,
      email: KNOWN_EMAIL,
      name: 'Aurora Owner',
      companyName: 'Aurora S.L.',
      tier: 'pro',
      stripeCustomerId: 'cus_aurora',
      goLiveAt: new Date('2026-05-29T09:00:00.000Z'),
      createdAt: new Date('2026-05-22T10:00:00.000Z'),
    });

    const res = await updateProfile(
      makeRequest({ contactName: '  Aurora Owner  ' }),
    );
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      where: { id: KNOWN_CLIENT_ID },
      data: { name: 'Aurora Owner' },
      select: expect.any(Object),
    });
    const body = await res.json();
    expect(body).toMatchObject({
      id: KNOWN_CLIENT_ID,
      contactName: 'Aurora Owner',
    });
  });

  it('updates primaryContactEmail (lowercased) for the session clientId', async () => {
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: KNOWN_CLIENT_ID,
      email: KNOWN_EMAIL,
      source: 'database',
    });
    update.mockResolvedValueOnce({
      id: KNOWN_CLIENT_ID,
      email: 'new-aurora@example.com',
      name: 'Aurora Owner',
      companyName: 'Aurora S.L.',
      tier: 'pro',
      stripeCustomerId: 'cus_aurora',
      goLiveAt: new Date('2026-05-29T09:00:00.000Z'),
      createdAt: new Date('2026-05-22T10:00:00.000Z'),
    });

    const res = await updateProfile(
      makeRequest({ primaryContactEmail: 'New-Aurora@Example.com' }),
    );
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      where: { id: KNOWN_CLIENT_ID },
      data: { email: 'new-aurora@example.com' },
      select: expect.any(Object),
    });
  });

  it('refuses to honor a clientId supplied in the body', async () => {
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: KNOWN_CLIENT_ID,
      email: KNOWN_EMAIL,
      source: 'database',
    });

    const res = await updateProfile(
      makeRequest({ contactName: 'Aurora Owner', clientId: 'OTHER_CLIENT' }),
    );
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('POST /api/portal/me/password', () => {
  it('returns 401 when no session', async () => {
    resolveClientFromSession.mockResolvedValueOnce(null);
    const res = await changePassword(
      makeRequest({ currentPassword: 'old', newPassword: 'newpass1234' }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('returns 400 + invalid_body detail when body shape is invalid', async () => {
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: KNOWN_CLIENT_ID,
      email: KNOWN_EMAIL,
      source: 'database',
    });
    const res = await changePassword(makeRequest({ currentPassword: 'old' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
    expect(typeof body.detail).toBe('string');
  });

  it('returns 400 + invalid_body detail when new password is too short', async () => {
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: KNOWN_CLIENT_ID,
      email: KNOWN_EMAIL,
      source: 'database',
    });
    const res = await changePassword(
      makeRequest({ currentPassword: 'oldpassword', newPassword: 'short' }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_body');
  });

  it('returns 404 when the session email does not resolve to a User', async () => {
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: KNOWN_CLIENT_ID,
      email: KNOWN_EMAIL,
      source: 'database',
    });
    findUnique.mockResolvedValueOnce(null);

    const res = await changePassword(
      makeRequest({ currentPassword: 'oldpassword', newPassword: 'newpassword123' }),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('user_not_found');
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('returns 409 when the user has not completed setup-password (null hash)', async () => {
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: KNOWN_CLIENT_ID,
      email: KNOWN_EMAIL,
      source: 'database',
    });
    findUnique.mockResolvedValueOnce({
      id: KNOWN_CLIENT_ID,
      userId: KNOWN_USER_ID,
    });
    findUnique.mockResolvedValueOnce({
      id: KNOWN_USER_ID,
      passwordHash: null,
      email: KNOWN_EMAIL,
    });

    const res = await changePassword(
      makeRequest({ currentPassword: 'oldpassword', newPassword: 'newpassword123' }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('must_complete_setup');
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('returns 409 when the user is in the __must_reset__ backfill state', async () => {
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: KNOWN_CLIENT_ID,
      email: KNOWN_EMAIL,
      source: 'database',
    });
    findUnique.mockResolvedValueOnce({
      id: KNOWN_CLIENT_ID,
      userId: KNOWN_USER_ID,
    });
    findUnique.mockResolvedValueOnce({
      id: KNOWN_USER_ID,
      passwordHash: '__must_reset__',
      email: KNOWN_EMAIL,
    });

    const res = await changePassword(
      makeRequest({ currentPassword: 'oldpassword', newPassword: 'newpassword123' }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('must_complete_setup');
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('returns 401 when the current password does not verify', async () => {
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: KNOWN_CLIENT_ID,
      email: KNOWN_EMAIL,
      source: 'database',
    });
    findUnique.mockResolvedValueOnce({
      id: KNOWN_CLIENT_ID,
      userId: KNOWN_USER_ID,
    });
    findUnique.mockResolvedValueOnce({
      id: KNOWN_USER_ID,
      passwordHash: 'argon2id-existing-hash',
      email: KNOWN_EMAIL,
    });
    verifyPassword.mockResolvedValueOnce(false);

    const res = await changePassword(
      makeRequest({ currentPassword: 'wrong-old', newPassword: 'newpassword123' }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('invalid_current_password');
    expect(hashPassword).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('updates the hash, sets passwordSetAt, invalidates reset tokens, returns reauth_required', async () => {
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: KNOWN_CLIENT_ID,
      email: KNOWN_EMAIL,
      source: 'database',
    });
    findUnique.mockResolvedValueOnce({
      id: KNOWN_CLIENT_ID,
      userId: KNOWN_USER_ID,
    });
    findUnique.mockResolvedValueOnce({
      id: KNOWN_USER_ID,
      passwordHash: 'argon2id-existing-hash',
      email: KNOWN_EMAIL,
    });
    verifyPassword.mockResolvedValueOnce(true);
    hashPassword.mockResolvedValueOnce('argon2id-new-hash');

    const res = await changePassword(
      makeRequest({ currentPassword: 'oldpassword', newPassword: 'newpassword123' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, reauth_required: true });

    expect(verifyPassword).toHaveBeenCalledWith('argon2id-existing-hash', 'oldpassword');
    expect(hashPassword).toHaveBeenCalledWith('newpassword123');
    expect(update).toHaveBeenCalledWith({
      where: { id: KNOWN_USER_ID },
      data: { passwordHash: 'argon2id-new-hash', passwordSetAt: expect.any(Date) },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { email: KNOWN_EMAIL, usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
  });

  it('never echoes the password hash or the new password in the response', async () => {
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: KNOWN_CLIENT_ID,
      email: KNOWN_EMAIL,
      source: 'database',
    });
    findUnique.mockResolvedValueOnce({
      id: KNOWN_CLIENT_ID,
      userId: KNOWN_USER_ID,
    });
    findUnique.mockResolvedValueOnce({
      id: KNOWN_USER_ID,
      passwordHash: 'argon2id-existing-hash',
      email: KNOWN_EMAIL,
    });
    verifyPassword.mockResolvedValueOnce(true);
    hashPassword.mockResolvedValueOnce('argon2id-new-hash');

    const res = await changePassword(
      makeRequest({ currentPassword: 'oldpassword', newPassword: 'newpassword123' }),
    );
    const body = await res.json();
    const stringified = JSON.stringify(body);
    expect(stringified.includes('argon2id')).toBe(false);
    expect(stringified.includes('newpassword123')).toBe(false);
  });

  it('runs the user update and the reset-token burn inside a single transaction', async () => {
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: KNOWN_CLIENT_ID,
      email: KNOWN_EMAIL,
      source: 'database',
    });
    findUnique.mockResolvedValueOnce({
      id: KNOWN_CLIENT_ID,
      userId: KNOWN_USER_ID,
    });
    findUnique.mockResolvedValueOnce({
      id: KNOWN_USER_ID,
      passwordHash: 'argon2id-existing-hash',
      email: KNOWN_EMAIL,
    });
    verifyPassword.mockResolvedValueOnce(true);
    hashPassword.mockResolvedValueOnce('argon2id-new-hash');

    const res = await changePassword(
      makeRequest({ currentPassword: 'oldpassword', newPassword: 'newpassword123' }),
    );
    expect(res.status).toBe(200);
    expect(transaction).toHaveBeenCalledTimes(1);
    const txArg = transaction.mock.calls[0][0];
    expect(Array.isArray(txArg)).toBe(true);
    expect(txArg).toHaveLength(2);
  });
});
