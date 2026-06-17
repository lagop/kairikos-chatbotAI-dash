// =============================================================================
// KAIA-753 — signIn callback unit test.
//
// Verifies the authConfig signIn callback:
//   * rejects unknown emails with a friendly "contact support" error
//   * accepts known emails by returning true
//   * normalises the email to lower-case + trim before lookup
//   * rejects when no email is provided
//
// The Prisma client is mocked with vi.fn() stubs that satisfy both the
// signIn callback (chatbotClientUser.findUnique) AND the new custom
// NextAuth adapter (verificationToken CRUD + chatbotClientUser
// createUser / updateUser / deleteUser / getUser). We never touch a
// real database — the goal is to lock the security-relevant branch
// logic.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @/lib/prisma so auth.ts (which imports KairikosPrismaAdapter)
// can load without a real DB connection. Each adapter method gets its
// own vi.fn so tests can assert on the exact call shapes.
const findUnique = vi.fn();
const update = vi.fn();
const deleteRow = vi.fn();
const createRow = vi.fn();
const verificationCreate = vi.fn();
const verificationDelete = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    chatbotClientUser: {
      findUnique: (...args: unknown[]) => findUnique(...args),
      update: (...args: unknown[]) => update(...args),
      delete: (...args: unknown[]) => deleteRow(...args),
      create: (...args: unknown[]) => createRow(...args),
    },
    verificationToken: {
      create: (...args: unknown[]) => verificationCreate(...args),
      delete: (...args: unknown[]) => verificationDelete(...args),
    },
  },
}));

// Import AFTER the mock is in place.
import { authConfig } from '../../auth';

const KNOWN_EMAIL = 'aurora@example.com';
const KNOWN_CLIENT_ID = 'client_aurora_001';
const KNOWN_USER_ID = 'user_aurora_001';

const baseUser = { id: KNOWN_USER_ID, email: KNOWN_EMAIL } as { id: string; email: string };

beforeEach(() => {
  findUnique.mockReset();
  update.mockReset();
  deleteRow.mockReset();
  createRow.mockReset();
  verificationCreate.mockReset();
  verificationDelete.mockReset();
});

describe('authConfig.callbacks.signIn', () => {
  it('accepts a known client email and returns true', async () => {
    findUnique.mockResolvedValueOnce({ clientId: KNOWN_CLIENT_ID });
    const signIn = authConfig.callbacks?.signIn;
    expect(signIn).toBeTypeOf('function');
    const result = await signIn!({ user: baseUser } as Parameters<NonNullable<typeof signIn>>[0]);
    expect(result).toBe(true);
    expect(findUnique).toHaveBeenCalledWith({
      where: { nextAuthEmail: KNOWN_EMAIL },
      select: { clientId: true },
    });
  });

  it('rejects an unknown email with a friendly support error', async () => {
    findUnique.mockResolvedValueOnce(null);
    const signIn = authConfig.callbacks?.signIn;
    expect(signIn).toBeTypeOf('function');
    await expect(
      signIn!({ user: { id: 'u2', email: 'random-user@example.com' } } as Parameters<
        NonNullable<typeof signIn>
      >[0]),
    ).rejects.toThrow(/no está configurada|hola@kairikos/);
    // The lookup was attempted — we did not bail before the DB read.
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('normalises the email to lower-case + trim before lookup', async () => {
    findUnique.mockResolvedValueOnce({ clientId: KNOWN_CLIENT_ID });
    const signIn = authConfig.callbacks?.signIn;
    await signIn!({
      user: { id: 'u3', email: `  ${KNOWN_EMAIL.toUpperCase()}  ` },
    } as Parameters<NonNullable<typeof signIn>>[0]);
    expect(findUnique).toHaveBeenCalledWith({
      where: { nextAuthEmail: KNOWN_EMAIL },
      select: { clientId: true },
    });
  });

  it('rejects when user.email is missing (returns false, no DB read)', async () => {
    const signIn = authConfig.callbacks?.signIn;
    const result = await signIn!({
      user: { id: 'u4' } as { id: string; email?: string | null },
    } as Parameters<NonNullable<typeof signIn>>[0]);
    expect(result).toBe(false);
    expect(findUnique).not.toHaveBeenCalled();
  });
});
