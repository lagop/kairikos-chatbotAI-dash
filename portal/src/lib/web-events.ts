import 'server-only';
import type { Prisma, PrismaClient } from '@prisma/client';
import { InMemoryRateLimiter } from './operator-crypto';
import { portalBaseUrl } from './portal-base-url';
import { WEB_CARE_PRODUCT_CODE } from './custom-care-rules';
import {
  generateEventsToken,
  isEventsTokenShape,
  WEB_EVENTS_PER_MINUTE,
  type ParsedWebEvent,
} from './web-events-rules';

// =============================================================================
// Informe mensual de resultados (28/11/2026) — lo que toca la base de datos
// del contrato de eventos. Las reglas puras, en web-events-rules.ts; el
// contrato para las webs, en docs/informe-mensual-web.md.
// =============================================================================

type Db = PrismaClient | Prisma.TransactionClient;

// Por IP y token, no solo por token como villas o cartera: aquí cada
// visitante manda sus propios eventos, y una web con tráfico real no debe
// quedarse sin contar porque un bucle en otra pestaña agotó el cupo. La IP
// solo vive en la memoria del proceso, un minuto, para este límite: nunca se
// escribe en ningún sitio.
const eventLimiter = new InMemoryRateLimiter(60 * 1000);

export function allowWebEvent(ip: string, token: string): boolean {
  return eventLimiter.check(`web-events:${ip}:${token}`, WEB_EVENTS_PER_MINUTE);
}

/** El sitio por su token. Un sitio archivado deja de contar. */
export async function findSiteByEventsToken(db: Db, token: string) {
  if (!isEventsTokenShape(token)) return null;
  return db.clientSite.findFirst({
    where: { eventsToken: token, archivedAt: null },
    select: { id: true, siteUrl: true },
  });
}

/**
 * Suma 1 al contador del día. Un solo INSERT … ON CONFLICT, sin leer antes:
 * dos eventos simultáneos no pueden pisarse, y la ruta pública hace una
 * escritura por evento, nunca dos.
 *
 * SQL directo porque el upsert de Prisma no sabe incrementar en el ON
 * CONFLICT (haría un SELECT y luego un UPDATE). El id se genera aquí con
 * gen_random_uuid(): la columna no tiene DEFAULT, Prisma lo pone en la app.
 */
export async function recordWebEvent(
  db: Db,
  input: { clientSiteId: string; day: string; event: ParsedWebEvent },
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "web_event_day" ("id", "client_site_id", "day", "kind", "source", "count", "updated_at")
    VALUES (gen_random_uuid(), ${input.clientSiteId}::uuid, ${input.day}::date, ${input.event.kind}, ${input.event.source}, 1, CURRENT_TIMESTAMP)
    ON CONFLICT ("client_site_id", "day", "kind", "source")
    DO UPDATE SET "count" = "web_event_day"."count" + 1, "updated_at" = CURRENT_TIMESTAMP
  `;
}

export function eventsEndpointUrl(token: string, baseUrl: string = portalBaseUrl()): string {
  return `${baseUrl}/api/public/web-events/${token}`;
}

/**
 * Activa la medición de un sitio: le da token si no lo tiene. Idempotente —
 * llamarla otra vez devuelve el mismo token—, porque el token ya está escrito
 * en la web publicada y cambiarlo sin querer la dejaría contando al vacío.
 */
export async function ensureEventsToken(
  db: Db,
  clientSiteId: string,
): Promise<{ ok: true; token: string; created: boolean } | { ok: false; error: 'not_found' }> {
  const site = await db.clientSite.findUnique({
    where: { id: clientSiteId },
    select: { id: true, eventsToken: true, archivedAt: true },
  });
  if (!site || site.archivedAt) return { ok: false, error: 'not_found' };
  if (site.eventsToken) return { ok: true, token: site.eventsToken, created: false };
  const token = generateEventsToken();
  // Condicionado a que siga sin token: si dos operadores pulsan a la vez,
  // gana uno y el otro lee el suyo, en vez de pisarlo.
  const updated = await db.clientSite.updateMany({
    where: { id: clientSiteId, eventsToken: null },
    data: { eventsToken: token },
  });
  if (updated.count === 1) return { ok: true, token, created: true };
  const again = await db.clientSite.findUnique({ where: { id: clientSiteId }, select: { eventsToken: true } });
  return again?.eventsToken ? { ok: true, token: again.eventsToken, created: false } : { ok: false, error: 'not_found' };
}

/** Lo que la ficha del operador enseña de la medición de una web
 *  (WebResultsTrackingPanel). `clientSiteId` null = sitio primario. */
export async function loadResultsTracking(
  db: Db,
  input: { clientId: string; clientSiteId: string | null; webActive: boolean },
): Promise<{
  webActive: boolean;
  endpoint: string | null;
  siteUrl: string | null;
  lastEventDay: string | null;
  hasActiveCare: boolean;
}> {
  const empty = { webActive: input.webActive, endpoint: null, siteUrl: null, lastEventDay: null, hasActiveCare: false };
  const site = await db.clientSite.findFirst({
    where: input.clientSiteId
      ? { id: input.clientSiteId, clientId: input.clientId }
      : { clientId: input.clientId, isPrimary: true },
    select: { id: true, siteUrl: true, eventsToken: true },
  });
  if (!site) return empty;
  const [lastEvent, care] = await Promise.all([
    site.eventsToken
      ? db.webEventDay.findFirst({ where: { clientSiteId: site.id }, orderBy: { day: 'desc' }, select: { day: true } })
      : null,
    db.clientProduct.count({
      where: { clientSiteId: site.id, status: 'active', product: { code: WEB_CARE_PRODUCT_CODE } },
    }),
  ]);
  return {
    webActive: input.webActive,
    endpoint: site.eventsToken ? eventsEndpointUrl(site.eventsToken) : null,
    siteUrl: site.siteUrl,
    // Columna DATE: Prisma la devuelve a medianoche UTC, así que el día es
    // el prefijo ISO tal cual.
    lastEventDay: lastEvent ? lastEvent.day.toISOString().slice(0, 10) : null,
    hasActiveCare: care > 0,
  };
}
