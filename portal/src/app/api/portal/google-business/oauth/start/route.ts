import { NextResponse, type NextRequest } from 'next/server';
import * as crypto from 'node:crypto';
import { resolveClientFromSession } from '@/lib/portal-session';
import { buildAuthorizationUrl, isGoogleBusinessOAuthConfigured, OAUTH_STATE_COOKIE } from '@/lib/google-business';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * WP-21 — GET /api/portal/google-business/oauth/start
 *
 * Meant to be navigated to directly (an `<a>`/`<Link>` from the portal),
 * not fetched — every outcome is a redirect. Mints a random `state`
 * value, stores it in a short-lived httpOnly cookie, and redirects to
 * Google's consent screen with the same value as the `state` query
 * param. The callback route validates the returned `state` against this
 * cookie (double-submit pattern) — the AC's "valida el parámetro state
 * contra la sesión para evitar CSRF".
 */
export async function GET(req: NextRequest) {
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    return NextResponse.redirect(new URL('/portal/login?next=/portal/resenas', req.url));
  }
  if (resolved.source !== 'database') {
    return NextResponse.redirect(new URL('/portal/resenas?connect_error=not_available_in_dev_mode', req.url));
  }
  if (!isGoogleBusinessOAuthConfigured()) {
    return NextResponse.redirect(new URL('/portal/resenas?connect_error=not_configured', req.url));
  }

  const state = crypto.randomBytes(32).toString('hex');
  const res = NextResponse.redirect(buildAuthorizationUrl(state));
  res.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/portal/google-business/oauth',
    maxAge: 600,
  });
  return res;
}
