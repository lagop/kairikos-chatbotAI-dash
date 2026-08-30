import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import {
  exchangeCodeForTokens,
  fetchAccessibleLocations,
  encryptRefreshToken,
  OAUTH_RETURN_COOKIE,
  OAUTH_STATE_COOKIE,
} from '@/lib/google-business';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const RETURN_TARGETS: Record<string, string> = {
  resenas: '/portal/resenas',
  llamadas: '/portal/llamadas',
};

/**
 * WP-21 — GET /api/portal/google-business/oauth/callback
 *
 * Every outcome redirects back to whichever page the client started
 * from (OAUTH_RETURN_COOKIE, set by the start route — falls back to
 * /portal/resenas if missing) with a `connected=1` or
 * `connect_error=<reason>` query param.
 *
 * Scope decision: if the connected Google user has access to more than
 * one Business Profile location, this route does NOT guess which one to
 * connect — `GoogleBusinessConnection` has no UI yet to let the client
 * pick, and silently picking "the first" risks managing the wrong
 * business's reviews. It redirects with
 * `connect_error=multiple_locations_unsupported` instead. Single-location
 * businesses (Kairikos's SMB target market) connect immediately.
 *
 * WP-XX — also binds the connection to the client's `recall`
 * subscription when it has one still missing `googleConnectionId`. This
 * is the fix for the bug where recall's review-request half could never
 * activate: nothing ever wrote that column, because this route (the
 * only place a GoogleBusinessConnection is ever created) only knew
 * about the standalone `reviews` product. The bind is unconditional and
 * idempotent — safe to run every time this route succeeds, whether the
 * client arrived from /portal/resenas or /portal/llamadas.
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookieState = req.cookies.get(OAUTH_STATE_COOKIE)?.value ?? null;
  const returnTo = RETURN_TARGETS[req.cookies.get(OAUTH_RETURN_COOKIE)?.value ?? ''] ?? RETURN_TARGETS.resenas;

  const redirectTo = (path: string) => {
    const res = NextResponse.redirect(new URL(path, req.url));
    res.cookies.set(OAUTH_STATE_COOKIE, '', { path: '/api/portal/google-business/oauth', maxAge: 0 });
    res.cookies.set(OAUTH_RETURN_COOKIE, '', { path: '/api/portal/google-business/oauth', maxAge: 0 });
    return res;
  };

  if (!code || !state || !cookieState || state !== cookieState) {
    return redirectTo(`${returnTo}?connect_error=csrf`);
  }
  if (!isDatabaseConfigured) {
    return redirectTo(`${returnTo}?connect_error=not_available_in_dev_mode`);
  }

  const resolved = await resolveClientFromSession();
  if (!resolved || resolved.source !== 'database') {
    return redirectTo(`/portal/login?next=${returnTo}`);
  }

  const tokens = await exchangeCodeForTokens(code);
  if (!tokens || !tokens.refreshToken) {
    return redirectTo(`${returnTo}?connect_error=token_exchange_failed`);
  }

  const locations = await fetchAccessibleLocations(tokens.accessToken);
  if (locations.length === 0) {
    return redirectTo(`${returnTo}?connect_error=no_locations`);
  }
  if (locations.length > 1) {
    return redirectTo(`${returnTo}?connect_error=multiple_locations_unsupported`);
  }
  const location = locations[0];

  const client = await prisma.chatbotClient.findUnique({
    where: { id: resolved.clientId },
    select: { tenantId: true },
  });
  if (!client?.tenantId) {
    return redirectTo(`${returnTo}?connect_error=no_tenant`);
  }

  const encrypted = encryptRefreshToken(tokens.refreshToken);
  const connection = await prisma.googleBusinessConnection.upsert({
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
    select: { id: true },
  });

  await prisma.recallSubscription.updateMany({
    where: { clientId: resolved.clientId, status: 'active', googleConnectionId: null },
    data: { googleConnectionId: connection.id },
  });

  return redirectTo(`${returnTo}?connected=1`);
}
