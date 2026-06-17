// =============================================================================
// KAIA-1736 — Custom NextAuth adapter unit tests.
//
// Locks the runtime fix that replaces `@auth/prisma-adapter` (which reads
// `prisma.user.*`, a model that does not exist in this schema) with a
// thin adapter that maps onto the real tables (`ChatbotClientUser`,
// `VerificationToken`).
//
// Covers the adapter surface the magic-link Email provider actually
// touches on `POST /api/auth/signin/nodemailer`:
//   * getUserByEmail       — the call that previously threw in production
//   * getUser              — used by the verify-request callback path
//   * createVerificationToken — inserts the magic-link token row
//   * useVerificationToken — consumes the row on click; returns null on
//     P2025 (double-click / retry) instead of throwing
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { KairikosPrismaAdapter } from '@/lib/auth-adapter';

const KNOWN_EMAIL = 'qa-test-client-a@kairikos.com';
const KNOWN_USER_ID = 'user_qa_001';
const KNOWN_CLIENT_ID = 'client_qa_001';

beforeEach(() => {
  findUnique.mockReset();
  update.mockReset();
  deleteRow.mockReset();
  createRow.mockReset();
  verificationCreate.mockReset();
  verificationDelete.mockReset();
});

describe('KairikosPrismaAdapter — user lookups', () => {
  it('getUserByEmail normalises email and resolves ChatbotClientUser', async () => {
    findUnique.mockResolvedValueOnce({
      id: KNOWN_USER_ID,
      nextAuthEmail: KNOWN_EMAIL,
      clientId: KNOWN_CLIENT_ID,
    });
    const adapter = KairikosPrismaAdapter();
    const user = await adapter.getUserByEmail!('  QA-Test-Client-A@Kairikos.com  ');
    expect(findUnique).toHaveBeenCalledWith({
      where: { nextAuthEmail: KNOWN_EMAIL },
    });
    expect(user).toEqual({
      id: KNOWN_USER_ID,
      email: KNOWN_EMAIL,
      emailVerified: null,
      name: null,
      image: null,
    });
  });

  it('getUserByEmail returns null when no ChatbotClientUser matches', async () => {
    findUnique.mockResolvedValueOnce(null);
    const adapter = KairikosPrismaAdapter();
    const user = await adapter.getUserByEmail!('unknown@example.com');
    expect(user).toBeNull();
  });

  it('getUser looks up by primary id', async () => {
    findUnique.mockResolvedValueOnce({
      id: KNOWN_USER_ID,
      nextAuthEmail: KNOWN_EMAIL,
      clientId: KNOWN_CLIENT_ID,
    });
    const adapter = KairikosPrismaAdapter();
    const user = await adapter.getUser!(KNOWN_USER_ID);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: KNOWN_USER_ID } });
    expect(user?.id).toBe(KNOWN_USER_ID);
  });

  it('createUser rejects when no ChatbotClientUser exists for the email', async () => {
    findUnique.mockResolvedValueOnce(null);
    const adapter = KairikosPrismaAdapter();
    await expect(
      adapter.createUser!({
        id: 'x',
        email: KNOWN_EMAIL,
        emailVerified: null,
        name: null,
        image: null,
      }),
    ).rejects.toThrow(/no ChatbotClientUser exists/);
  });

  it('createUser returns the existing ChatbotClientUser as an AdapterUser', async () => {
    findUnique.mockResolvedValueOnce({
      id: KNOWN_USER_ID,
      nextAuthEmail: KNOWN_EMAIL,
      clientId: KNOWN_CLIENT_ID,
    });
    const adapter = KairikosPrismaAdapter();
    const user = await adapter.createUser!({
      id: 'x',
      email: KNOWN_EMAIL,
      emailVerified: null,
      name: null,
      image: null,
    });
    expect(user.id).toBe(KNOWN_USER_ID);
    expect(user.email).toBe(KNOWN_EMAIL);
  });

  it('updateUser with a new email normalises and persists it', async () => {
    update.mockResolvedValueOnce({
      id: KNOWN_USER_ID,
      nextAuthEmail: 'new@example.com',
      clientId: KNOWN_CLIENT_ID,
    });
    const adapter = KairikosPrismaAdapter();
    const user = await adapter.updateUser!({
      id: KNOWN_USER_ID,
      email: '  NEW@example.com  ',
      emailVerified: null,
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: KNOWN_USER_ID },
      data: { nextAuthEmail: 'new@example.com' },
    });
    expect(user.email).toBe('new@example.com');
  });

  it('deleteUser removes the ChatbotClientUser row', async () => {
    deleteRow.mockResolvedValueOnce({ id: KNOWN_USER_ID });
    const adapter = KairikosPrismaAdapter();
    await adapter.deleteUser!(KNOWN_USER_ID);
    expect(deleteRow).toHaveBeenCalledWith({ where: { id: KNOWN_USER_ID } });
  });
});

describe('KairikosPrismaAdapter — verification tokens', () => {
  it('createVerificationToken persists the token and strips the auto id', async () => {
    verificationCreate.mockResolvedValueOnce({
      id: 'auto-id-1',
      identifier: KNOWN_EMAIL,
      token: 'hashed-token-abc',
      expires: new Date('2026-06-18T00:00:00Z'),
    });
    const adapter = KairikosPrismaAdapter();
    const row = await adapter.createVerificationToken!({
      identifier: KNOWN_EMAIL,
      token: 'hashed-token-abc',
      expires: new Date('2026-06-18T00:00:00Z'),
    });
    expect(verificationCreate).toHaveBeenCalledWith({
      data: {
        identifier: KNOWN_EMAIL,
        token: 'hashed-token-abc',
        expires: new Date('2026-06-18T00:00:00Z'),
      },
    });
    expect(row).not.toHaveProperty('id');
    expect(row.token).toBe('hashed-token-abc');
  });

  it('useVerificationToken returns the row on a successful delete', async () => {
    verificationDelete.mockResolvedValueOnce({
      id: 'auto-id-1',
      identifier: KNOWN_EMAIL,
      token: 'hashed-token-abc',
      expires: new Date('2026-06-18T00:00:00Z'),
    });
    const adapter = KairikosPrismaAdapter();
    const row = await adapter.useVerificationToken!({
      identifier: KNOWN_EMAIL,
      token: 'hashed-token-abc',
    });
    expect(verificationDelete).toHaveBeenCalledWith({
      where: { identifier_token: { identifier: KNOWN_EMAIL, token: 'hashed-token-abc' } },
    });
    expect(row?.token).toBe('hashed-token-abc');
  });

  it('useVerificationToken returns null on P2025 (double-click / retry)', async () => {
    const p2025 = Object.assign(new Error('Record to delete does not exist'), { code: 'P2025' });
    verificationDelete.mockRejectedValueOnce(p2025);
    const adapter = KairikosPrismaAdapter();
    const row = await adapter.useVerificationToken!({
      identifier: KNOWN_EMAIL,
      token: 'already-used',
    });
    expect(row).toBeNull();
  });

  it('useVerificationToken rethrows non-P2025 errors', async () => {
    const other = new Error('connection refused');
    verificationDelete.mockRejectedValueOnce(other);
    const adapter = KairikosPrismaAdapter();
    await expect(
      adapter.useVerificationToken!({
        identifier: KNOWN_EMAIL,
        token: 'hashed-token-abc',
      }),
    ).rejects.toThrow('connection refused');
  });
});
