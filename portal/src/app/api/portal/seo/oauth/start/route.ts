import { NextResponse, type NextRequest } from 'next/server';
import * as crypto from 'node:crypto';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { getSession } from '@/lib/session';
import { resolveContractedInstance } from '@/lib/client-product-access';
import { encodeOAuthState } from '@/lib/seo-oauth-state';
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
  // Fase 2 multi-instancia — la conexión es de UNA web. El id de la
  // contratación llega por query desde el enlace de su página; si no viene,
  // resolveContractedInstance devuelve la única que haya (y null si hay
  // varias, que es negarse en vez de conectar la web equivocada).
  const instance = await resolveContractedInstance(prisma, {
    clientId: resolved.clientId,
    productCode: 'seo',
    clientProductId: req.nextUrl.searchParams.get('clientProductId'),
  });
  if (!instance) {
    return NextResponse.redirect(new URL('/portal/seo?connect_error=forbidden', req.url));
  }
  if (!(await isSearchConsoleOAuthConfigured())) {
    return NextResponse.redirect(new URL('/portal/seo?connect_error=not_configured', req.url));
  }

  const nonce = crypto.randomBytes(32).toString('hex');
  const state = nonce;
  const res = NextResponse.redirect(await buildAuthorizationUrl(state));
  // A Google solo viaja el nonce; el id de la contratación se queda en la
  // cookie httpOnly. Ver lib/seo-oauth-state.ts.
  res.cookies.set(OAUTH_STATE_COOKIE, encodeOAuthState(nonce, instance.clientProductId), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/portal/seo/oauth',
    maxAge: 600,
  });
  return res;
}
