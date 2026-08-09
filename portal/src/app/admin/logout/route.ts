// KAIA-13101 — operator-view logout route that returns a 303 redirect.
//
// Mirrors the customer pattern at `src/app/api/portal/logout/route.ts:52`
// (which 303-redirects to /portal/login) but adapted for the operator
// auth surface. Reuses `revokeSession` + `clearSessionCookie` from
// `@/lib/operator-session` — no logic duplication.
//
// The form in `src/app/admin/layout.tsx` posts here from the
// "Salir del modo soporte" button. Returning JSON (the way the
// canonical `/api/operator/logout` route does) breaks the UX because
// a JSON POST does not navigate the browser; the user has to refresh
// to see the unauthenticated state. This route solves that by 303-ing
// to /admin/login and clearing the `kairikos_operator_session`
// cookie on the same response.

import { NextResponse, type NextRequest } from 'next/server';
import { getSessionCookieId, revokeSession, clearSessionCookie } from '@/lib/operator-session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function logout(req: NextRequest) {
  const sessionId = getSessionCookieId(req);
  if (sessionId) {
    await revokeSession(sessionId);
  }
  const res = NextResponse.redirect(new URL('/admin/login', req.url), 303);
  const cookie = clearSessionCookie();
  res.cookies.set(cookie.name, cookie.value, cookie.options);
  return res;
}

export async function POST(req: NextRequest) {
  return logout(req);
}

export async function GET(req: NextRequest) {
  return logout(req);
}