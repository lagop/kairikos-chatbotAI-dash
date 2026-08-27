import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import {
  exchangeCodeForTokens,
  fetchVerifiedSites,
  matchVerifiedSite,
  encryptRefreshToken,
  OAUTH_STATE_COOKIE,
} from '@/lib/google-search-console';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * SEO con IA, Fase B — GET /api/portal/seo/oauth/callback
 *
 * Every outcome redirects to /portal/seo with a `connected=1` or
 * `connect_error=<reason>` query param — same shape as
 * /api/portal/google-business/oauth/callback (WP-21).
 *
 * Scope decision: requires SeoProfile.siteUrl to already be set (the
 * client fills that in during onboarding, Fase A) and requires it to
 * match a VERIFIED Search Console property in the connected account —
 * this route does NOT guess or auto-verify a site. A mismatch redirects
 * with `connect_error=site_not_verified` instead of silently connecting
 * to the wrong property or none at all.
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookieState = req.cookies.get(OAUTH_STATE_COOKIE)?.value ?? null;

  const redirectTo = (path: string) => {
    const res = NextResponse.redirect(new URL(path, req.url));
    res.cookies.set(OAUTH_STATE_COOKIE, '', { path: '/api/portal/seo/oauth', maxAge: 0 });
    return res;
  };

  if (!code || !state || !cookieState || state !== cookieState) {
    return redirectTo('/portal/seo?connect_error=csrf');
  }
  if (!isDatabaseConfigured) {
    return redirectTo('/portal/seo?connect_error=not_available_in_dev_mode');
  }

  const resolved = await resolveClientFromSession();
  if (!resolved || resolved.source !== 'database') {
    return redirectTo('/portal/login?next=/portal/seo');
  }

  const profile = await prisma.seoProfile.findFirst({
    where: { clientId: resolved.clientId },
    select: { siteUrl: true },
  });
  if (!profile?.siteUrl) {
    return redirectTo('/portal/seo?connect_error=no_site_url');
  }

  const tokens = await exchangeCodeForTokens(code);
  if (!tokens || !tokens.refreshToken) {
    return redirectTo('/portal/seo?connect_error=token_exchange_failed');
  }

  const verifiedSites = await fetchVerifiedSites(tokens.accessToken);
  const matchedSite = matchVerifiedSite(profile.siteUrl, verifiedSites);
  if (!matchedSite) {
    return redirectTo('/portal/seo?connect_error=site_not_verified');
  }

  const client = await prisma.chatbotClient.findUnique({
    where: { id: resolved.clientId },
    select: { tenantId: true },
  });
  if (!client?.tenantId) {
    return redirectTo('/portal/seo?connect_error=no_tenant');
  }

  const encrypted = encryptRefreshToken(tokens.refreshToken);
  await prisma.googleSeoConnection.upsert({
    where: { clientId: resolved.clientId },
    create: {
      clientId: resolved.clientId,
      tenantId: client.tenantId,
      searchConsoleSiteUrl: matchedSite,
      refreshTokenCiphertext: encrypted.ciphertext,
      refreshTokenIv: encrypted.iv,
      refreshTokenTag: encrypted.tag,
      scopes: tokens.scope ? tokens.scope.split(' ') : [],
      status: 'active',
    },
    update: {
      searchConsoleSiteUrl: matchedSite,
      refreshTokenCiphertext: encrypted.ciphertext,
      refreshTokenIv: encrypted.iv,
      refreshTokenTag: encrypted.tag,
      scopes: tokens.scope ? tokens.scope.split(' ') : [],
      status: 'active',
      lastSyncError: null,
    },
  });

  return redirectTo('/portal/seo?connected=1');
}
