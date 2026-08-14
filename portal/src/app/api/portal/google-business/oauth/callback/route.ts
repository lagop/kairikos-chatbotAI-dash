import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import {
  exchangeCodeForTokens,
  fetchAccessibleLocations,
  encryptRefreshToken,
  OAUTH_STATE_COOKIE,
} from '@/lib/google-business';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * WP-21 — GET /api/portal/google-business/oauth/callback
 *
 * Every outcome redirects to /portal/resenas with a `connected=1` or
 * `connect_error=<reason>` query param — there is no client-facing UI
 * wired to read these yet (that's WP-22's "superficie de cliente"), but
 * the reasons are stable strings a future picker/status UI can key off.
 *
 * Scope decision: if the connected Google user has access to more than
 * one Business Profile location, this route does NOT guess which one to
 * connect — `GoogleBusinessConnection` has no UI yet to let the client
 * pick, and silently picking "the first" risks managing the wrong
 * business's reviews. It redirects with
 * `connect_error=multiple_locations_unsupported` instead. Single-location
 * businesses (Kairikos's SMB target market) connect immediately.
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookieState = req.cookies.get(OAUTH_STATE_COOKIE)?.value ?? null;

  const redirectTo = (path: string) => {
    const res = NextResponse.redirect(new URL(path, req.url));
    res.cookies.set(OAUTH_STATE_COOKIE, '', { path: '/api/portal/google-business/oauth', maxAge: 0 });
    return res;
  };

  if (!code || !state || !cookieState || state !== cookieState) {
    return redirectTo('/portal/resenas?connect_error=csrf');
  }
  if (!isDatabaseConfigured) {
    return redirectTo('/portal/resenas?connect_error=not_available_in_dev_mode');
  }

  const resolved = await resolveClientFromSession();
  if (!resolved || resolved.source !== 'database') {
    return redirectTo('/portal/login?next=/portal/resenas');
  }

  const tokens = await exchangeCodeForTokens(code);
  if (!tokens || !tokens.refreshToken) {
    return redirectTo('/portal/resenas?connect_error=token_exchange_failed');
  }

  const locations = await fetchAccessibleLocations(tokens.accessToken);
  if (locations.length === 0) {
    return redirectTo('/portal/resenas?connect_error=no_locations');
  }
  if (locations.length > 1) {
    return redirectTo('/portal/resenas?connect_error=multiple_locations_unsupported');
  }
  const location = locations[0];

  const client = await prisma.chatbotClient.findUnique({
    where: { id: resolved.clientId },
    select: { tenantId: true },
  });
  if (!client?.tenantId) {
    return redirectTo('/portal/resenas?connect_error=no_tenant');
  }

  const encrypted = encryptRefreshToken(tokens.refreshToken);
  await prisma.googleBusinessConnection.upsert({
    where: { clientId_locationId: { clientId: resolved.clientId, locationId: location.locationId } },
    create: {
      clientId: resolved.clientId,
      tenantId: client.tenantId,
      googleAccountId: location.accountId,
      locationId: location.locationId,
      locationName: location.locationName,
      refreshTokenCiphertext: encrypted.ciphertext,
      refreshTokenIv: encrypted.iv,
      refreshTokenTag: encrypted.tag,
      scopes: tokens.scope ? tokens.scope.split(' ') : [],
      status: 'active',
    },
    update: {
      googleAccountId: location.accountId,
      locationName: location.locationName,
      refreshTokenCiphertext: encrypted.ciphertext,
      refreshTokenIv: encrypted.iv,
      refreshTokenTag: encrypted.tag,
      scopes: tokens.scope ? tokens.scope.split(' ') : [],
      status: 'active',
      lastSyncError: null,
    },
  });

  return redirectTo('/portal/resenas?connected=1');
}
