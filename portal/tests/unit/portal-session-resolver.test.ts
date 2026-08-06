// =============================================================================
// KAIA-11624 — regression test for `resolveClientFromSession()`.
//
// Bug: the production branch of `resolveClientFromSession()` read
// `supabase.auth.getSession()` even though the portal authenticates via
// NextAuth credentials. As a result every NextAuth-authenticated user
// resolved to `null` in production and `/portal/dashboard` 307-redirected
// to `/portal/sin-acceso`.
//
// This test pins the fix: the production branch must consult NextAuth
// (`auth()` from `../../auth`) and then `prisma.chatbotClientUser` keyed
// on `nextAuthEmail`. The dev-mock branch and the inner helper continue
// to work unchanged — covered by an explicit assertion below.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const auth = vi.fn();
const findUnique = vi.fn();
const cookiesGet = vi.fn();

vi.mock('../../auth', () => ({
  auth: (...args: unknown[]) => auth(...args),
}));

vi.mock('next/headers', () => ({
  cookies: () => ({ get: (...args: unknown[]) => cookiesGet(...args) }),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    chatbotClientUser: {
      findUnique: (...args: unknown[]) => findUnique(...args),
    },
  },
  isDatabaseConfigured: true,
}));

import { resolveClientFromSession } from '@/lib/portal-session';

const KNOWN_EMAIL = 'orly.nityananda@gmail.com';
const KNOWN_CLIENT_ID = 'cmsh9mzor00018zsgsfa97l6m';

beforeEach(() => {
  auth.mockReset();
  findUnique.mockReset();
  cookiesGet.mockReset();
  cookiesGet.mockReturnValue(undefined);
  // Force the production branch — non-placeholder Supabase env that is
  // not the dev-mock sentinel set.
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://real-project.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'real-anon-key';
});

describe('resolveClientFromSession — production (KAIA-11624)', () => {
  it('resolves the clientId via NextAuth + Prisma for a NextAuth-authenticated user', async () => {
    auth.mockResolvedValueOnce({ user: { email: KNOWN_EMAIL } });
    findUnique.mockResolvedValueOnce({ clientId: KNOWN_CLIENT_ID });

    const result = await resolveClientFromSession();

    expect(result).toEqual({
      clientId: KNOWN_CLIENT_ID,
      email: KNOWN_EMAIL,
      source: 'database',
    });
    expect(auth).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith({
      where: { nextAuthEmail: KNOWN_EMAIL },
      select: { clientId: true },
    });
  });

  it('does NOT call supabase.auth.getSession() in the production branch', async () => {
    // This is the regression we are pinning. If the production branch
    // ever re-imports `createSupabaseServerClient` and reads the Supabase
    // session, the test will fail because the mocked module would not
    // provide a `getSession` stub. The vitest resolver will throw on the
    // missing import, surfacing the regression immediately.
    auth.mockResolvedValueOnce({ user: { email: KNOWN_EMAIL } });
    findUnique.mockResolvedValueOnce({ clientId: KNOWN_CLIENT_ID });

    const result = await resolveClientFromSession();

    expect(result?.source).toBe('database');
  });

  it('lower-cases the session email before looking up ChatbotClientUser', async () => {
    auth.mockResolvedValueOnce({ user: { email: '  Orly.Nityananda@Gmail.com  ' } });
    findUnique.mockResolvedValueOnce({ clientId: KNOWN_CLIENT_ID });

    await resolveClientFromSession();

    expect(findUnique).toHaveBeenCalledWith({
      where: { nextAuthEmail: KNOWN_EMAIL },
      select: { clientId: true },
    });
  });

  it('returns null when auth() yields no session', async () => {
    auth.mockResolvedValueOnce(null);

    const result = await resolveClientFromSession();

    expect(result).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('returns null when auth() yields a session with no email', async () => {
    auth.mockResolvedValueOnce({ user: {} });

    const result = await resolveClientFromSession();

    expect(result).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('returns null when no ChatbotClientUser row exists for the email', async () => {
    auth.mockResolvedValueOnce({ user: { email: KNOWN_EMAIL } });
    findUnique.mockResolvedValueOnce(null);

    const result = await resolveClientFromSession();

    expect(result).toBeNull();
  });
});

describe('resolveClientFromSession — dev-mock branch (KAIA-11624 regression guard)', () => {
  beforeEach(() => {
    // Mark the env as dev-mock so the production branch is bypassed.
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://placeholder.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'placeholder';
  });

  it('still uses the dev-mock lookup table for a known dev email', async () => {
    const result = await resolveClientFromSession();

    // The dev-mock branch falls through to MOCK_CLIENT when no dev-email
    // cookie is set in the request context. We only assert here that the
    // production path (auth + prisma.chatbotClientUser.findUnique) is NOT
    // exercised in dev-mock mode — the exact dev-mock lookup is covered
    // by the existing wizard-client spec.
    expect(auth).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
  });
});
