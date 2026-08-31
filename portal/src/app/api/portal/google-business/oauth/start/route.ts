import { NextResponse, type NextRequest } from 'next/server';
import * as crypto from 'node:crypto';
import { isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { getSession } from '@/lib/session';
import {
  buildAuthorizationUrl,
  hasGoogleBusinessConnectAccess,
  isGoogleBusinessOAuthConfigured,
  OAUTH_RETURN_COOKIE,
  OAUTH_STATE_COOKIE,
} from '@/lib/google-business';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Whitelisted so the return cookie can never carry an open redirect —
 *  anything else falls back to 'resenas', the original destination. */
const RETURN_TARGETS: Record<string, string> = {
  resenas: '/portal/resenas',
  llamadas: '/portal/llamadas',
};

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
 *
 * WP-22a — gated on the client having 'reviews' OR 'recall' contracted
 * (hasGoogleBusinessConnectAccess): recall bundles the same WhatsApp
 * review-request flow (see recall-reviews.ts) and needs this same
 * connection but has no other screen to reach it from. `?from=` records
 * which of those two pages sent the client here, so the callback can
 * send them back to the one they started on instead of always assuming
 * /portal/resenas.
 */
export async function GET(req: NextRequest) {
  const from = req.nextUrl.searchParams.get('from') ?? '';
  const returnKey = from in RETURN_TARGETS ? from : 'resenas';
  const returnTo = RETURN_TARGETS[returnKey];

  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.redirect(new URL(`/portal/login?next=${returnTo}`, req.url));
  }
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    return NextResponse.redirect(new URL(`/portal/login?next=${returnTo}`, req.url));
  }
  if (resolved.source !== 'database' || !isDatabaseConfigured) {
    return NextResponse.redirect(new URL(`${returnTo}?connect_error=not_available_in_dev_mode`, req.url));
  }
  const hasAccess = await hasGoogleBusinessConnectAccess(resolved.clientId);
  if (!hasAccess) {
    return NextResponse.redirect(new URL(`${returnTo}?connect_error=forbidden`, req.url));
  }
  if (!(await isGoogleBusinessOAuthConfigured())) {
    return NextResponse.redirect(new URL(`${returnTo}?connect_error=not_configured`, req.url));
  }

  const state = crypto.randomBytes(32).toString('hex');
  const res = NextResponse.redirect(await buildAuthorizationUrl(state));
  const cookieOpts = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/api/portal/google-business/oauth',
    maxAge: 600,
  };
  res.cookies.set(OAUTH_STATE_COOKIE, state, cookieOpts);
  res.cookies.set(OAUTH_RETURN_COOKIE, returnKey, cookieOpts);
  return res;
}
