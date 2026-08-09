// KAIA-2878 — portal-side logout endpoint.
//
// Mirrors the operator-view disable flow in
// `src/app/api/portal/operator/route.ts`: a small HTML form posts here,
// we clear the auth + dev-marker cookies and 303-redirect to the role's
// login page. No JS client required; works for both real credentials
// sessions (NextAuth JWT cookie cleared by `signOut`) and the dev-mock
// session (which never set a NextAuth cookie in the first place, so we
// clear our own `kairikos-portal-dev-session` marker explicitly).

import { NextResponse, type NextRequest } from 'next/server';
import { signOut } from '../../../../../auth';
import { getSession } from '@/lib/session';

const PORTAL_LOGIN = '/portal/login';
const ADMIN_LOGIN = '/admin/login';

const DEV_SESSION_COOKIE = 'kairikos-portal-dev-session';
const OPERATOR_COOKIE = 'kairikos-portal-operator';

function clearAuthCookies(res: NextResponse) {
  res.cookies.set(DEV_SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  res.cookies.set(OPERATOR_COOKIE, '', { path: '/', maxAge: 0 });
}

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const returnTo = (form?.get('return_to') as string | null) ?? null;

  let role: 'operator' | 'client' = 'client';
  try {
    const session = await getSession();
    if (session.isOperator) role = 'operator';
  } catch {
    role = 'client';
  }

  try {
    await signOut({ redirect: false });
  } catch {
    // signOut may throw in dev-mock mode (no NextAuth cookie present);
    // the explicit cookie clears below still land the user on the login page.
  }

  const target =
    returnTo && returnTo.startsWith('/')
      ? returnTo
      : role === 'operator'
        ? ADMIN_LOGIN
        : PORTAL_LOGIN;

  const res = NextResponse.redirect(new URL(target, req.url), 303);
  clearAuthCookies(res);
  return res;
}

export async function GET(req: NextRequest) {
  return POST(req);
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';