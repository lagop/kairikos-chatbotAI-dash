import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { parseAuthorizeCallback, WORDPRESS_CONNECT_STATE_COOKIE } from '@/lib/wordpress-connect';
import { encryptWordPressAppPassword } from '@/lib/seo';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * SEO con IA, Fase 5 — GET /api/portal/seo/wordpress/callback
 *
 * A dónde redirige WordPress tras la pantalla de autorizar-aplicación.
 * Cada desenlace redirige a /portal/seo con `wp_connected=1` o
 * `wp_connect_error=<motivo>` — mismo patrón que
 * /api/portal/seo/oauth/callback.
 *
 * NUNCA registra la query cruda ni la contraseña — solo metadatos (ver
 * la nota de logError abajo). La cifra con encryptWordPressAppPassword
 * antes de escribir nada, y esta es la ÚNICA vez que existe en memoria
 * como texto plano en todo este servidor.
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const state = url.searchParams.get('state');
  const cookieState = req.cookies.get(WORDPRESS_CONNECT_STATE_COOKIE)?.value ?? null;

  const redirectTo = (path: string) => {
    const res = NextResponse.redirect(new URL(path, req.url));
    res.cookies.set(WORDPRESS_CONNECT_STATE_COOKIE, '', { path: '/api/portal/seo/wordpress', maxAge: 0 });
    return res;
  };

  if (!state || !cookieState || state !== cookieState) {
    return redirectTo('/portal/seo?wp_connect_error=csrf');
  }
  if (!isDatabaseConfigured) {
    return redirectTo('/portal/seo?wp_connect_error=not_available_in_dev_mode');
  }

  const resolved = await resolveClientFromSession();
  if (!resolved || resolved.source !== 'database') {
    return redirectTo('/portal/login?next=/portal/seo');
  }

  const parsed = parseAuthorizeCallback(url.searchParams);
  if (!parsed.ok) {
    // El cliente pulsó "Rechazar" en WordPress vuelve por reject_url, no
    // por aquí — llegar aquí sin credenciales es casi siempre WordPress
    // devolviendo un error propio, o alguien tocando la URL a mano.
    return redirectTo('/portal/seo?wp_connect_error=wordpress_incomplete_response');
  }

  const profile = await prisma.seoProfile.findFirst({
    where: { clientId: resolved.clientId },
    select: { id: true, tenantId: true, wordpressAppPasswordCiphertext: true, technicalSetupCompletedAt: true },
  });
  if (!profile) {
    return redirectTo('/portal/seo?wp_connect_error=no_profile');
  }

  let encrypted: ReturnType<typeof encryptWordPressAppPassword>;
  try {
    encrypted = encryptWordPressAppPassword(parsed.password);
  } catch (err) {
    // No se registra `err` con el mensaje tal cual: si algún día
    // encryptWordPressAppPassword cambiase y su error incluyera el
    // valor de entrada, esto lo evita por diseño, no solo por costumbre.
    logError('wordpress_connect.encrypt_failed', new Error('encryption_failed'), { clientId: resolved.clientId }, 'warn');
    return redirectTo('/portal/seo?wp_connect_error=internal_error');
  }

  // Mismo criterio que technical-setup/route.ts: se sella solo la
  // primera vez que URL + contraseña quedan ambas en la fila.
  const justCompleted = !profile.technicalSetupCompletedAt;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.seoProfile.update({
        where: { id: profile.id },
        data: {
          wordpressUrl: parsed.siteUrl,
          wordpressUsername: parsed.username,
          wordpressAppPasswordCiphertext: encrypted.ciphertext,
          wordpressAppPasswordIv: encrypted.iv,
          wordpressAppPasswordTag: encrypted.tag,
          ...(justCompleted ? { technicalSetupCompletedAt: new Date() } : {}),
        },
      });
      await tx.seoProfileAudit.create({
        data: {
          profileId: profile.id,
          clientId: resolved.clientId,
          tenantId: profile.tenantId,
          action: 'technical_setup_updated',
          before: { hasAppPassword: profile.wordpressAppPasswordCiphertext !== null },
          // Nunca la contraseña ni su cifrado — solo lo que la propia
          // tabla ya documenta como seguro de auditar.
          after: { wordpressUrl: parsed.siteUrl, wordpressUsername: parsed.username, hasAppPassword: true },
          actorType: 'client',
          actorOperatorId: null,
          actorEmail: `client:${resolved.clientId}`,
        },
      });
    });
  } catch (err) {
    logError('wordpress_connect.save_failed', err, { clientId: resolved.clientId }, 'warn');
    return redirectTo('/portal/seo?wp_connect_error=internal_error');
  }

  return redirectTo('/portal/seo?wp_connected=1');
}
