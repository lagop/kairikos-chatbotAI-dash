// =============================================================================
// KAIA-753 — signIn callback unit test.
//
// Verifies the authConfig signIn callback:
//   * rejects unknown emails with a friendly "contact support" error
//   * accepts known emails by returning true
//   * normalises the email to lower-case + trim before lookup
//   * rejects when no email is provided
//
// The Prisma client is mocked with a vi.fn() that returns
// `findUnique` results keyed by the lookup argument. We never touch a real
// database — the goal is to lock the security-relevant branch logic.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @/lib/prisma so authConfig can import it without a real DB connection.
// The mock is wired before auth.ts is loaded, so the authConfig singleton
// captures the mocked prisma reference.
const findUnique = vi.fn();
vi.mock('@/lib/prisma', () => ({
  prisma: {
    chatbotClientUser: { findUnique: (...args: unknown[]) => findUnique(...args) },
  },
}));

// Import AFTER the mock is in place.
import { authConfig } from '../../auth';

const KNOWN_EMAIL = 'aurora@example.com';
const KNOWN_CLIENT_ID = 'client_aurora_001';

const baseUser = { id: 'user_001', email: KNOWN_EMAIL } as { id: string; email: string };

beforeEach(() => {
  findUnique.mockReset();
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
