// KAIA-13101 — operator-view logout route that returns a 303 redirect.
//
// Mirrors the customer pattern at `src/app/api/portal/logout/route.ts`
// (which 303-redirects to /portal/login) but adapted for the operator
// auth surface. Reuses `revokeSession` + `clearSessionCookie` from
// `@/lib/operator-session` for the operator session table row, and
// NextAuth's `signOut` helper for the NextAuth JWT cookie — no logic
// duplication on either side.
//
// The form in `src/app/admin/layout.tsx` posts here from the
// "Salir del modo soporte" button. Returning JSON (the way the
// canonical `/api/operator/logout` route does) breaks the UX because
// a JSON POST does not navigate the browser; the user has to refresh
// to see the unauthenticated state. This route solves that by 303-ing
// to /admin/login, clearing the `kairikos_operator_session` cookie,
// AND calling `signOut({ redirect: false })` so the NextAuth JWT
// cookie is also cleared.
//
// Why both clears matter: the operator dashboard at `/admin/portal`
// is gated by `getSession()` which calls NextAuth's `auth()` to read
// the operator JWT cookie. If only `kairikos_operator_session` is
// cleared, the NextAuth JWT cookie survives and the operator can
// still navigate back into `/admin/portal` after the logout redirect.
// This was the regression the board reported in the latest reply on
// KAIA-12227 — clearing both cookies is what makes the unauthenticated
// contract hold after a logout.

import { NextResponse, type NextRequest } from 'next/server';
import { getSessionCookieId, revokeSession, clearSessionCookie } from '@/lib/operator-session';
import { signOut } from '../../../../auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function logout(req: NextRequest) {
  const sessionId = getSessionCookieId(req);
  if (sessionId) {
    await revokeSession(sessionId);
  }
  try {
    await signOut({ redirect: false });
  } catch {
    // signOut may throw in dev-mock mode (no NextAuth cookie present);
    // the explicit operator cookie clear below still lands the user on
    // the login page. Same defense-in-depth pattern used by
    // `src/app/api/portal/logout/route.ts:39`.
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
