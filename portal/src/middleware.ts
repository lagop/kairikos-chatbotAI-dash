import { NextResponse, type NextRequest } from 'next/server';

const DEV_SESSION_COOKIE = 'kairikos-portal-dev-session';
const DEV_SESSION_ACTIVE_COOKIE = 'kairikos-portal-dev-session-active';
const OPERATOR_COOKIE = 'kairikos-portal-operator';

export default function middleware(req: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const isDevMock =
    !supabaseUrl ||
    supabaseUrl.includes('YOUR-PROJECT') ||
    supabaseUrl === 'https://invalid.supabase.co';

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-pathname', req.nextUrl.pathname);
  const res = NextResponse.next({ request: { headers: requestHeaders } });

  if (!isDevMock) {
    return res;
  }

  // KAIA-4011 — gate the dev-mock auto-reseed on a separate flag cookie.
  // The flag is set by the dev login flow (or by a script seed) and is
  // explicitly cleared by the logout server action. Without the flag, the
  // middleware never re-creates the dev session, so back-navigation after
  // logout (or a fresh tab with no cookies) cannot resurrect the seeded
  // profile. This restores the unauth → 307 contract the QA spec requires.
  const activeFlag = req.cookies.get(DEV_SESSION_ACTIVE_COOKIE);
  if (activeFlag) {
    if (!req.cookies.get(DEV_SESSION_COOKIE)) {
      res.cookies.set(DEV_SESSION_COOKIE, '1', {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: 60 * 60 * 12,
      });
    }
    if (!req.cookies.get(OPERATOR_COOKIE)) {
      res.cookies.set(OPERATOR_COOKIE, '1', {
        httpOnly: false,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: 60 * 60 * 8,
      });
    }
  } else {
    // Explicitly clear any stale dev-session cookies that survived a
    // previous deploy or a partial logout. Defense in depth: even if
    // the action's `cookies().delete(...)` did not propagate (Edge
    // race), the next request will not see the active flag and will
    // not reseed. requirePortalSession() then redirects to /portal/login.
    if (req.cookies.get(DEV_SESSION_COOKIE) || req.cookies.get(OPERATOR_COOKIE)) {
      res.cookies.set(DEV_SESSION_COOKIE, '', { path: '/', maxAge: 0 });
      res.cookies.set(OPERATOR_COOKIE, '', { path: '/', maxAge: 0 });
    }
  }
  return res;
}

export const config = {
  // KAIA-1909 — extend the dev-mock cookie matcher so the operator cookie
  // is also seeded on `/admin/portal/*`. In production, cookie seeding is
  // skipped (the production branch returns early above); the
  // `x-kaia-operator-key` header fallback in `src/lib/session.ts` covers
  // staging QA. Both paths must be reachable for the QA smoke pass.
  matcher: ['/portal/:path*', '/admin/portal/:path*'],
};