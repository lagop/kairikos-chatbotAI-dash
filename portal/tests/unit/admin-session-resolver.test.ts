// =============================================================================
// Regression test for getSession()'s admin/operator path (src/lib/session.ts).
//
// Bug: isPortalDevMock() (a Supabase-env-var heuristic unrelated to whether
// a real session exists) gated the ENTIRE auth() lookup — in any
// environment with placeholder Supabase env vars (e.g. local dev, where
// Supabase isn't used for auth at all), a genuinely logged-in operator via
// the real /admin/login form (NextAuth admin-credentials) was silently
// bounced to the "no_session" shape, and every /admin/portal/* page
// redirected to /portal/login. Caught by logging in for real against a
// local Postgres and being redirected away from /admin/portal/clients
// despite a valid, verified NextAuth session (confirmed via
// GET /api/auth/session returning {role: 'operator'}).
//
// This is the identical bug class already fixed once in
// resolveClientFromSession() (portal-session.ts, KAIA-11624) — this test
// pins the same fix in getSession(), its admin-facing sibling.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const auth = vi.fn();
const findUniqueUser = vi.fn();
const findUniqueClientUser = vi.fn();
const cookiesGet = vi.fn();
const headersGet = vi.fn();

vi.mock('../../auth', () => ({
  auth: (...args: unknown[]) => auth(...args),
}));

vi.mock('next/headers', () => ({
  cookies: () => ({ get: (...args: unknown[]) => cookiesGet(...args) }),
  headers: () => ({ get: (...args: unknown[]) => headersGet(...args) }),
}));

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findUnique: (...args: unknown[]) => findUniqueUser(...args) },
    chatbotClientUser: { findUnique: (...args: unknown[]) => findUniqueClientUser(...args) },
  },
}));

vi.mock('@/lib/portal-data', () => ({
  MOCK_CLIENT: { id: 'mock_client_1', slug: 'acme-corp', primaryContactEmail: 'mock@kairikos.com' },
  MOCK_SECONDARY_CLIENT: { id: 'mock_client_2', slug: 'globex-inc', primaryContactEmail: 'mock2@kairikos.com' },
}));

vi.mock('@/lib/operator-crypto', () => ({
  constantTimeEqual: (a: string, b: string) => a === b,
}));

const isPortalDevMock = vi.fn();
vi.mock('@/lib/portal-session', () => ({
  isPortalDevMock: () => isPortalDevMock(),
}));

const getValidSession = vi.fn();
const touchSession = vi.fn();
vi.mock('@/lib/operator-session', () => ({
  SESSION_COOKIE_NAME: 'kairikos_operator_session',
  getValidSession: (...args: unknown[]) => getValidSession(...args),
  touchSession: (...args: unknown[]) => touchSession(...args),
}));

import { getSession } from '@/lib/session';

const OPERATOR_EMAIL = 'lucia@kairikos.com';

function withOperatorCookie(sessionId = 'sess_op_1') {
  cookiesGet.mockImplementation((name: string) =>
    name === 'kairikos_operator_session' ? { value: sessionId } : undefined,
  );
}

beforeEach(() => {
  auth.mockReset();
  findUniqueUser.mockReset();
  findUniqueClientUser.mockReset();
  cookiesGet.mockReset().mockReturnValue(undefined);
  headersGet.mockReset().mockReturnValue(null);
  isPortalDevMock.mockReset();
  getValidSession.mockReset().mockResolvedValue(null);
  touchSession.mockReset().mockResolvedValue(undefined);
  delete process.env.KAIA_OPERATOR_API_KEY;
});

// Seguridad (22/09/2026): ser operador sale SOLO de la OperatorSession, que
// nace después del segundo factor y se puede revocar. El rol del JWT de
// NextAuth ya no cuenta — era la puerta con contraseña sola.
describe('getSession — el operador sale de su OperatorSession, no del JWT', () => {
  it('una OperatorSession válida da isOperator, aunque isPortalDevMock() sea true', async () => {
    isPortalDevMock.mockReturnValue(true);
    withOperatorCookie();
    getValidSession.mockResolvedValueOnce({
      operatorId: 'op_1', email: OPERATOR_EMAIL, totpVerifiedAt: new Date(), lastUsedAt: new Date(),
    });

    const session = await getSession();

    expect(getValidSession).toHaveBeenCalledWith('sess_op_1');
    expect(session.isOperator).toBe(true);
    expect(session.email).toBe(OPERATOR_EMAIL);
    expect(session.userId).toBe('op_1');
    expect(auth).not.toHaveBeenCalled();
  });

  it('un JWT de NextAuth con rol operador, sin OperatorSession, ya no es operador', async () => {
    isPortalDevMock.mockReturnValue(false);
    auth.mockResolvedValueOnce({ user: { email: OPERATOR_EMAIL, role: 'operator' } });
    findUniqueUser.mockResolvedValueOnce({ id: 'user_op', role: 'operator' });
    findUniqueClientUser.mockResolvedValueOnce(null);

    const session = await getSession();

    expect(session.isOperator).toBe(false);
  });

  it('una cookie de sesión revocada, caducada o sin segundo factor no es operador', async () => {
    isPortalDevMock.mockReturnValue(false);
    withOperatorCookie('sess_revocada');
    getValidSession.mockResolvedValueOnce(null);
    auth.mockResolvedValueOnce(null);

    const session = await getSession();

    expect(session.isOperator).toBe(false);
    expect(session.reason).toBe('no_session');
  });

  it('marca el uso de la sesión como mucho cada 5 minutos', async () => {
    withOperatorCookie();
    getValidSession.mockResolvedValueOnce({
      operatorId: 'op_1', email: OPERATOR_EMAIL, totpVerifiedAt: new Date(), lastUsedAt: new Date(),
    });
    await getSession();
    expect(touchSession).not.toHaveBeenCalled();

    getValidSession.mockResolvedValueOnce({
      operatorId: 'op_1', email: OPERATOR_EMAIL, totpVerifiedAt: new Date(), lastUsedAt: new Date(Date.now() - 10 * 60_000),
    });
    await getSession();
    expect(touchSession).toHaveBeenCalledWith('sess_op_1');
  });

  it('still resolves a real client session correctly (existing behavior preserved)', async () => {
    isPortalDevMock.mockReturnValue(true);
    auth.mockResolvedValueOnce({ user: { email: 'client@example.com' } });
    findUniqueUser.mockResolvedValueOnce({ id: 'user_1', role: 'client' });
    findUniqueClientUser.mockResolvedValueOnce({ clientId: 'client_1', client: { email: 'client@example.com' } });

    const session = await getSession();

    expect(session.isOperator).toBe(false);
    expect(session.hasClientAccess).toBe(true);
    expect(session.clientId).toBe('client_1');
  });
});

describe('getSession — dev-mock fallback only when there is no real session', () => {
  beforeEach(() => {
    isPortalDevMock.mockReturnValue(true);
  });

  it('falls back to the dev-mock session when auth() yields nothing and the dev-session cookie is active', async () => {
    auth.mockResolvedValueOnce(null);
    cookiesGet.mockImplementation((name: string) =>
      name === 'kairikos-portal-dev-session-active' ? { value: '1' } : undefined,
    );

    const session = await getSession();

    expect(auth).toHaveBeenCalledTimes(1);
    expect(session.isOperator).toBe(false);
    expect(session.hasClientAccess).toBe(true);
    expect(session.email).toBe('mock@kairikos.com');
  });

  it('returns no_session when auth() yields nothing and the dev-session cookie is absent', async () => {
    auth.mockResolvedValueOnce(null);

    const session = await getSession();

    expect(session.reason).toBe('no_session');
    expect(session.isOperator).toBe(false);
  });

  it('returns no_session when auth() yields nothing and isPortalDevMock() is false', async () => {
    isPortalDevMock.mockReturnValue(false);
    auth.mockResolvedValueOnce(null);

    const session = await getSession();

    expect(session.reason).toBe('no_session');
  });
});

describe('getSession — operator-key bypass still takes priority over everything', () => {
  it('short-circuits before auth() when x-kaia-operator-key matches', async () => {
    process.env.KAIA_OPERATOR_API_KEY = 'shared-secret';
    headersGet.mockImplementation((name: string) => (name === 'x-kaia-operator-key' ? 'shared-secret' : null));

    const session = await getSession();

    expect(session.isOperator).toBe(true);
    expect(auth).not.toHaveBeenCalled();
  });
});
