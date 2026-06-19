import { NextResponse, type NextRequest } from 'next/server';

const DEV_SESSION_COOKIE = 'kairikos-portal-dev-session';
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