import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getLocationAllowance } from '@/lib/review-locations';
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
 * Fase 3 — varias ubicaciones. Hasta aquí, una cuenta de Google con más
 * de un local se rechazaba con `multiple_locations_unsupported`: no había
 * pantalla donde elegir y coger «el primero» arriesgaba gestionar las
 * reseñas del negocio equivocado. Ese riesgo desapareció al haber
 * selector, así que ahora se conectan TODAS las que quepan en la tarifa
 * del cliente (TIER_LOCATION_CAP, src/lib/review-locations.ts) y él elige
 * después en cuál trabajar.
 *
 * Conectar de más se rechaza ENTERO, con `connect_error=location_limit`,
 * antes de escribir una sola fila: dejarle tres locales de cinco sin
 * explicar por qué es peor que no conectar ninguno.
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

  // Fase 3 — varias ubicaciones. Antes se rechazaba aquí, porque no había
  // dónde elegir y coger la primera arriesgaba gestionar las reseñas del
  // negocio equivocado. Ahora se conectan TODAS las que quepan en la
  // tarifa, y el cliente elige después en qué local trabajar: conectar no
  // es un acto destructivo (leer reseñas no cambia nada en Google), así
  // que traerlas todas es mejor que hacerle repetir el OAuth por cada una.
  //
  // El tope de la tarifa se comprueba ANTES de escribir nada: quedarse a
  // medias, con tres locales conectados de cinco y sin decir por qué, es
  // peor que no conectar ninguno.
  const allowance = await getLocationAllowance(prisma, resolved.clientId);
  const alreadyKnown = new Set(
    (
      await prisma.googleBusinessConnection.findMany({
        where: { clientId: resolved.clientId },
        select: { locationId: true },
      })
    ).map((row) => row.locationId),
  );
  const incoming = locations.filter((l) => !alreadyKnown.has(l.locationId));

  if (incoming.length > allowance.remaining) {
    return redirectTo(
      `${returnTo}?connect_error=location_limit&cap=${allowance.cap}&found=${locations.length}`,
    );
  }

  const client = await prisma.chatbotClient.findUnique({
    where: { id: resolved.clientId },
    select: { tenantId: true },
  });
  if (!client?.tenantId) {
    return redirectTo(`${returnTo}?connect_error=no_tenant`);
  }

  const encrypted = encryptRefreshToken(tokens.refreshToken);

  // Una fila por local. El upsert por (clientId, locationId) hace que
  // reconectar refresque el token de los que ya estaban en vez de
  // duplicarlos, que es justo lo que pasa cuando alguien vuelve a pasar
  // por aquí porque un local se le quedó en 'needs_reconnect'.
  const connectionIds: string[] = [];
  for (const location of locations) {
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
    connectionIds.push(connection.id);
  }

  // Recall pide reseñas a UN local. Se ata al primero solo mientras el
  // cliente no haya elegido: con varios, elegir por él es precisamente lo
  // que esta fase quita, y hay un selector en /portal/llamadas para eso.
  await prisma.recallSubscription.updateMany({
    where: { clientId: resolved.clientId, status: 'active', googleConnectionId: null },
    data: { googleConnectionId: connectionIds[0] },
  });

  return redirectTo(`${returnTo}?connected=1`);
}
