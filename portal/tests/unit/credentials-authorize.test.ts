// =============================================================================
// KAIA-2103 — Credentials authorize unit test.
//
// Verifies the authConfig providers[0].authorize callback:
//   * returns null for missing email or password
//   * returns null for unknown email (no user found)
//   * returns null for user with no passwordHash set
//   * returns null for wrong password
//   * returns user object with id, email, clientId, role for correct credentials
//
// The Prisma client is mocked with vi.fn() stubs. We never touch a real database.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @/lib/prisma so auth.ts can load without a real DB connection.
const findUnique = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    chatbotClientUser: {
      findUnique: (...args: unknown[]) => findUnique(...args),
    },
  },
}));

// Mock @/lib/operator-crypto so we can control verifyPassword behavior.
const verifyPassword = vi.fn();

vi.mock('@/lib/operator-crypto', () => ({
  verifyPassword: (...args: unknown[]) => verifyPassword(...args),
}));

// Import AFTER the mocks are in place.
import { authConfig } from '../../auth';

const KNOWN_EMAIL = 'aurora@example.com';
const KNOWN_CLIENT_ID = 'client_aurora_001';
const KNOWN_USER_ID = 'user_aurora_001';
const CORRECT_PASSWORD = 's3cr3tP@ssw0rd';
const WRONG_PASSWORD = 'wrongpassword';

beforeEach(() => {
  findUnique.mockReset();
  verifyPassword.mockReset();
});

function buildCredentials(email: string, password: string) {
  return { email, password };
}

describe('authConfig.providers[0].authorize (Credentials)', () => {
  it('returns null when email is missing', async () => {
    const provider = authConfig.providers[0] as { authorize: (c: unknown) => Promise<unknown> };
    const result = await provider.authorize({ password: { value: CORRECT_PASSWORD } });
    expect(result).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('returns null when password is missing', async () => {
    const provider = authConfig.providers[0] as { authorize: (c: unknown) => Promise<unknown> };
    const result = await provider.authorize({ email: { value: KNOWN_EMAIL } });
    expect(result).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('returns null for unknown email', async () => {
    findUnique.mockResolvedValueOnce(null);
    const provider = authConfig.providers[0] as { authorize: (c: unknown) => Promise<unknown> };
    const result = await provider.authorize(buildCredentials('unknown@example.com', CORRECT_PASSWORD));
    expect(result).toBeNull();
    expect(findUnique).toHaveBeenCalledWith({
      where: { nextAuthEmail: 'unknown@example.com' },
      select: { id: true, clientId: true, passwordHash: true },
    });
  });

  it('returns null when user has no passwordHash set', async () => {
    findUnique.mockResolvedValueOnce({ id: KNOWN_USER_ID, clientId: KNOWN_CLIENT_ID, passwordHash: null });
    const provider = authConfig.providers[0] as { authorize: (c: unknown) => Promise<unknown> };
    const result = await provider.authorize(buildCredentials(KNOWN_EMAIL, CORRECT_PASSWORD));
    expect(result).toBeNull();
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('returns null for wrong password', async () => {
    findUnique.mockResolvedValueOnce({ id: KNOWN_USER_ID, clientId: KNOWN_CLIENT_ID, passwordHash: 'argon2hash' });
    verifyPassword.mockResolvedValueOnce(false);
    const provider = authConfig.providers[0] as { authorize: (c: unknown) => Promise<unknown> };
    const result = await provider.authorize(buildCredentials(KNOWN_EMAIL, WRONG_PASSWORD));
    expect(result).toBeNull();
    expect(verifyPassword).toHaveBeenCalledWith('argon2hash', WRONG_PASSWORD);
  });

  it('returns user object for correct credentials', async () => {
    findUnique.mockResolvedValueOnce({ id: KNOWN_USER_ID, clientId: KNOWN_CLIENT_ID, passwordHash: 'argon2hash' });
    verifyPassword.mockResolvedValueOnce(true);
    const provider = authConfig.providers[0] as { authorize: (c: unknown) => Promise<unknown> };
    const result = await provider.authorize(buildCredentials(KNOWN_EMAIL, CORRECT_PASSWORD));
    expect(result).toEqual({
      id: KNOWN_USER_ID,
      email: KNOWN_EMAIL,
      clientId: KNOWN_CLIENT_ID,
      role: 'client',
    });
  });

  it('normalises email to lower-case before lookup', async () => {
    findUnique.mockResolvedValueOnce({ id: KNOWN_USER_ID, clientId: KNOWN_CLIENT_ID, passwordHash: 'argon2hash' });
    verifyPassword.mockResolvedValueOnce(true);
    const provider = authConfig.providers[0] as { authorize: (c: unknown) => Promise<unknown> };
    await provider.authorize(buildCredentials('AURORA@EXAMPLE.COM', CORRECT_PASSWORD));
    expect(findUnique).toHaveBeenCalledWith({
      where: { nextAuthEmail: KNOWN_EMAIL },
      select: { id: true, clientId: true, passwordHash: true },
    });
  });

  it('trims whitespace from email before lookup', async () => {
    findUnique.mockResolvedValueOnce({ id: KNOWN_USER_ID, clientId: KNOWN_CLIENT_ID, passwordHash: 'argon2hash' });
    verifyPassword.mockResolvedValueOnce(true);
    const provider = authConfig.providers[0] as { authorize: (c: unknown) => Promise<unknown> };
    await provider.authorize(buildCredentials(`  ${KNOWN_EMAIL}  `, CORRECT_PASSWORD));
    expect(findUnique).toHaveBeenCalledWith({
      where: { nextAuthEmail: KNOWN_EMAIL },
      select: { id: true, clientId: true, passwordHash: true },
    });
  });
});

describe('authConfig.callbacks.jwt', () => {
  it('embeds clientId and role from user into token', async () => {
    const jwt = authConfig.callbacks?.jwt;
    expect(jwt).toBeTypeOf('function');
    const token = await jwt!({ token: {}, user: { id: 'u1', email: 'a@b.com', clientId: 'cid1', role: 'client' } });
    expect(token).toMatchObject({ clientId: 'cid1', role: 'client' });
  });

  it('passes token through when no user', async () => {
    const jwt = authConfig.callbacks?.jwt;
    const token = { foo: 'bar' };
    const result = await jwt!({ token, user: undefined });
    expect(result).toEqual(token);
  });
});

describe('authConfig.callbacks.session', () => {
  it('embeds clientId and role from token into session.user', async () => {
    const session = authConfig.callbacks?.session;
    expect(session).toBeTypeOf('function');
    const user = {};
    const result = await session!({
      session: { user },
      token: { clientId: 'cid1', role: 'client' },
    });
    expect(result.user).toMatchObject({ clientId: 'cid1', role: 'client' });
  });
});
