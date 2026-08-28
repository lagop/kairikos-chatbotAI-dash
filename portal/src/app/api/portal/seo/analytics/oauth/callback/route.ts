import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { exchangeCodeForTokens, encryptRefreshToken, OAUTH_STATE_COOKIE } from '@/lib/google-analytics';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * SEO con IA — GET /api/portal/seo/analytics/oauth/callback
 *
 * Unlike Search Console's callback, this one does NOT try to resolve a
 * single property automatically — it can't (see
 * GoogleAnalyticsConnection's schema comment). It saves the encrypted
 * tokens and leaves the connection in 'pending_property_selection';
 * the client picks their property on /portal/seo next, via
 * GET .../analytics/properties (live list) + POST .../analytics/select-property.
 *
 * Every outcome redirects to /portal/seo with a `ga_connected=1` or
 * `ga_connect_error=<reason>` query param — same shape as the Search
 * Console callback.
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookieState = req.cookies.get(OAUTH_STATE_COOKIE)?.value ?? null;

  const redirectTo = (path: string) => {
    const res = NextResponse.redirect(new URL(path, req.url));
    res.cookies.set(OAUTH_STATE_COOKIE, '', { path: '/api/portal/seo/analytics/oauth', maxAge: 0 });
    return res;
  };

  if (!code || !state || !cookieState || state !== cookieState) {
    return redirectTo('/portal/seo?ga_connect_error=csrf');
  }
  if (!isDatabaseConfigured) {
    return redirectTo('/portal/seo?ga_connect_error=not_available_in_dev_mode');
  }

  const resolved = await resolveClientFromSession();
  if (!resolved || resolved.source !== 'database') {
    return redirectTo('/portal/login?next=/portal/seo');
  }

  const tokens = await exchangeCodeForTokens(code);
  if (!tokens || !tokens.refreshToken) {
    return redirectTo('/portal/seo?ga_connect_error=token_exchange_failed');
  }

  const client = await prisma.chatbotClient.findUnique({
    where: { id: resolved.clientId },
    select: { tenantId: true },
  });
  if (!client?.tenantId) {
    return redirectTo('/portal/seo?ga_connect_error=no_tenant');
  }

  const encrypted = encryptRefreshToken(tokens.refreshToken);
  await prisma.googleAnalyticsConnection.upsert({
    where: { clientId: resolved.clientId },
    create: {
      clientId: resolved.clientId,
      tenantId: client.tenantId,
      refreshTokenCiphertext: encrypted.ciphertext,
      refreshTokenIv: encrypted.iv,
      refreshTokenTag: encrypted.tag,
      scopes: tokens.scope ? tokens.scope.split(' ') : [],
      status: 'pending_property_selection',
    },
    update: {
      // Reconnecting (e.g. after needs_reconnect) drops any previously
      // selected property — a fresh consent grant may be for a
      // different Google account with a different set of properties,
      // so re-picking is the safe default rather than silently keeping
      // a stale propertyId that might not even be accessible anymore.
      propertyId: null,
      propertyDisplayName: null,
      refreshTokenCiphertext: encrypted.ciphertext,
      refreshTokenIv: encrypted.iv,
      refreshTokenTag: encrypted.tag,
      scopes: tokens.scope ? tokens.scope.split(' ') : [],
      status: 'pending_property_selection',
      lastSyncError: null,
    },
  });

  return redirectTo('/portal/seo?ga_connected=1');
}
