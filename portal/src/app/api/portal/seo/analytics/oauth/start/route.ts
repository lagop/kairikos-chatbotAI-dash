import { NextResponse, type NextRequest } from 'next/server';
import * as crypto from 'node:crypto';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { getSession } from '@/lib/session';
import { isProductContracted } from '@/lib/client-product-access';
import { buildAuthorizationUrl, isAnalyticsOAuthConfigured, OAUTH_STATE_COOKIE } from '@/lib/google-analytics';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * SEO con IA — GET /api/portal/seo/analytics/oauth/start
 *
 * Meant to be navigated to directly, not fetched — every outcome is a
 * redirect. Same CSRF double-submit-cookie mechanism as
 * /api/portal/seo/oauth/start (Search Console). Unlike that route,
 * there is no "does SeoProfile.siteUrl exist yet" gate here — a GA4
 * property can't be matched by URL anyway (see
 * GoogleAnalyticsConnection's schema comment), so nothing is checked
 * until the client picks a property after connecting.
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
    return NextResponse.redirect(new URL('/portal/seo?ga_connect_error=not_available_in_dev_mode', req.url));
  }
  const hasSeo = await isProductContracted(prisma, resolved.clientId, 'seo');
  if (!hasSeo) {
    return NextResponse.redirect(new URL('/portal/seo?ga_connect_error=forbidden', req.url));
  }
  if (!isAnalyticsOAuthConfigured()) {
    return NextResponse.redirect(new URL('/portal/seo?ga_connect_error=not_configured', req.url));
  }

  const state = crypto.randomBytes(32).toString('hex');
  const res = NextResponse.redirect(buildAuthorizationUrl(state));
  res.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/portal/seo/analytics/oauth',
    maxAge: 600,
  });
  return res;
}
