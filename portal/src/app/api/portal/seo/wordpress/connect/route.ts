import { NextResponse, type NextRequest } from 'next/server';
import * as crypto from 'node:crypto';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { getSession } from '@/lib/session';
import { isProductContracted } from '@/lib/client-product-access';
import { buildAuthorizeApplicationUrl, WORDPRESS_CONNECT_STATE_COOKIE } from '@/lib/wordpress-connect';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * SEO con IA, Fase 5 — GET /api/portal/seo/wordpress/connect
 *
 * Pensada para navegarse directamente, no para hacerle fetch — cada
 * desenlace es una redirección. Mismo mecanismo CSRF de doble cookie que
 * /api/portal/seo/oauth/start (WP-21): un `state` aleatorio en una
 * cookie httpOnly de corta vida, validado por el callback — aquí viaja
 * en la propia `success_url` porque WordPress no tiene un `state` propio
 * que echar de vuelta (ver la cabecera de lib/wordpress-connect.ts).
 *
 * Exige un SeoProfile con `cmsType: 'wordpress'` y `siteUrl` puesto:
 * sin URL no hay wp-admin al que redirigir, y para cualquier otro CMS
 * esta pantalla no existe — el alta manual del operador sigue siendo el
 * camino para ellos.
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
    return NextResponse.redirect(new URL('/portal/seo?wp_connect_error=not_available_in_dev_mode', req.url));
  }
  const hasSeo = await isProductContracted(prisma, resolved.clientId, 'seo');
  if (!hasSeo) {
    return NextResponse.redirect(new URL('/portal/seo?wp_connect_error=forbidden', req.url));
  }

  const profile = await prisma.seoProfile.findFirst({
    where: { clientId: resolved.clientId },
    select: { siteUrl: true, cmsType: true },
  });
  if (!profile?.siteUrl) {
    return NextResponse.redirect(new URL('/portal/seo?wp_connect_error=no_site_url', req.url));
  }
  if (profile.cmsType !== 'wordpress') {
    return NextResponse.redirect(new URL('/portal/seo?wp_connect_error=not_wordpress', req.url));
  }

  const state = crypto.randomBytes(32).toString('hex');
  const successUrl = new URL('/api/portal/seo/wordpress/callback', req.url);
  successUrl.searchParams.set('state', state);
  const rejectUrl = new URL('/portal/seo?wp_connect_error=wordpress_rejected', req.url);

  const authorizeUrl = buildAuthorizeApplicationUrl(profile.siteUrl, {
    successUrl: successUrl.toString(),
    rejectUrl: rejectUrl.toString(),
  });
  if (!authorizeUrl) {
    return NextResponse.redirect(new URL('/portal/seo?wp_connect_error=invalid_site_url', req.url));
  }

  const res = NextResponse.redirect(authorizeUrl);
  res.cookies.set(WORDPRESS_CONNECT_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/portal/seo/wordpress',
    maxAge: 600,
  });
  return res;
}
