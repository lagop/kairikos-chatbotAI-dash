import { NextResponse, type NextRequest } from 'next/server';
import * as crypto from 'node:crypto';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { getSession } from '@/lib/session';
import { isProductContracted } from '@/lib/client-product-access';
import { buildAuthorizationUrl, isSearchConsoleOAuthConfigured, OAUTH_STATE_COOKIE } from '@/lib/google-search-console';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * SEO con IA, Fase B — GET /api/portal/seo/oauth/start
 *
 * Meant to be navigated to directly, not fetched — every outcome is a
 * redirect. Same CSRF double-submit-cookie mechanism as
 * /api/portal/google-business/oauth/start (WP-21): a random `state`
 * stored in a short-lived httpOnly cookie, validated by the callback.
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.redirect(new URL('/portal/login?next=/portal/seo', req.url));
  }
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    return NextResponse.redirect(new URL('/portal/login?next=/portal/seo', req.url));
  }
  if (resolved.source !== 'database' || !isDatabaseConfigured) {
    return NextResponse.redirect(new URL('/portal/seo?connect_error=not_available_in_dev_mode', req.url));
  }
  const hasSeo = await isProductContracted(prisma, resolved.clientId, 'seo');
  if (!hasSeo) {
    return NextResponse.redirect(new URL('/portal/seo?connect_error=forbidden', req.url));
  }
  if (!isSearchConsoleOAuthConfigured()) {
    return NextResponse.redirect(new URL('/portal/seo?connect_error=not_configured', req.url));
  }

  const state = crypto.randomBytes(32).toString('hex');
  const res = NextResponse.redirect(buildAuthorizationUrl(state));
  res.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/portal/seo/oauth',
    maxAge: 600,
  });
  return res;
}
