import 'server-only';
import { createHash } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { getPlaceDetails } from './google-places';
import { MIN_PHONE_MATCH_DIGITS, phoneDigits } from './prospecting-replies';
import { logError } from './observability';

// =============================================================================
// 26/10/2026 — caducidad del contenido de Google Places en la prospección.
//
// Las condiciones de Google Maps Platform solo dejan guardar sin plazo el
// place ID, y las coordenadas hasta 30 días. El barrido de prospección
// guardaba en Lead, sin plazo, el nombre, el teléfono, la web, la dirección
// (dentro de `summary`), la categoría y las coordenadas que devuelve Place
// Details; y la foto de la zona (ProspectingCompetitorSnapshot) guardaba
// valoraciones y competidores.
//
// La salida que menos rompe el producto:
//
//   1. Coordenadas: a los 30 días se borran, en todos los leads. El informe
//      sin coordenadas busca por zona en vez de por calle (ya lo hacía con los
//      leads anteriores a A1), así que no se rompe nada.
//   2. El resto, a los 30 días, solo en los prospectos que NADIE ha tocado:
//      se borra y queda el place ID, con el que se vuelve a pedir a Google
//      cuando hace falta (lista diaria de llamadas, informe del operador).
//      Volver a pedirlo abre otra ventana de 30 días.
//   3. Un prospecto con el que ya hay relación —se le llamó (contactedAt),
//      respondió, tiene conversación, se convirtió, o ya recibió un mensaje
//      automático— no se purga: su nombre y su teléfono son ya datos de una
//      relación nuestra, no una copia de Google, y además hacen falta para
//      seguir la secuencia y atribuir respuestas.
//   4. Las bajas y los descartados sin relación sí se purgan, pero dejan la
//      huella del teléfono (phoneHash): la supresión «este número dijo que
//      no» tiene que seguir funcionando sin guardar el número.
//   5. La foto de la zona se vacía a los 30 días; la fila y su testigo se
//      quedan para que el enlace enviado diga «caducado» en vez de 404.
//
// Que la ventana de 30 días valga también para el nombre o el teléfono es
// una lectura nuestra: las condiciones solo la dan expresamente para las
// coordenadas. Es la misma ventana que ya usaba la foto de la zona
// (SNAPSHOT_TTL_DAYS) y la más defendible sin dejar el producto inservible;
// si Google o un abogado dicen otra cosa, se cambia PLACES_RETENTION_DAYS.
// =============================================================================

export const PLACES_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Topes de refresco al día. Cada refresco es un Place Details Enterprise
 *  (teléfono y web): 20 $ por 1.000 pasado el cupo gratuito de 1.000 al mes.
 *
 *  - Por cliente, 25: más que la lista diaria de llamadas (15) y que lo que
 *    un cliente de Prospección mira en un día (su tarifa más alta trae 800
 *    negocios al MES, unos 27 al día). Lo justo para que un clic de «revisar
 *    todo» no le cueste a Kairikos más de 0,50 $ en un día.
 *  - Global, 150: unos 3 $ al día como máximo entre todos los clientes y el
 *    operador; con el volumen de hoy no se acerca al cupo gratuito.
 *
 *  Se cuentan en LeadAudit (acciones de PLACES_REFRESH_ACTIONS) y no en
 *  memoria: un contador en memoria vuelve a cero con cada despliegue, y
 *  entonces no es un tope. */
export const CLIENT_DAILY_REFRESH_CAP = 25;
export const GLOBAL_DAILY_REFRESH_CAP = 150;
export const PLACES_REFRESH_ACTIONS = ['places_refreshed', 'places_unavailable'] as const;
const REFRESH_CACHE_MS = 60 * 60 * 1000;

export function retentionCutoff(now: Date): Date {
  return new Date(now.getTime() - PLACES_RETENTION_DAYS * DAY_MS);
}

/** Huella del teléfono: sha256 de sus 9 últimas cifras, las mismas que usa
 *  phonesMatch para decir que dos números son el mismo. Null si no llega. */
export function phoneHashOf(phone: string | null | undefined): string | null {
  const digits = phoneDigits(phone);
  if (digits.length < MIN_PHONE_MATCH_DIGITS) return null;
  return createHash('sha256').update(digits.slice(-MIN_PHONE_MATCH_DIGITS)).digest('hex');
}

/** ¿Este teléfono es el de esta huella? */
export function phoneMatchesHash(phone: string | null | undefined, hash: string | null | undefined): boolean {
  if (!hash) return false;
  return phoneHashOf(phone) === hash;
}

export interface RetentionLeadState {
  externalPlaceId: string | null;
  placesFetchedAt: Date | null;
  placesPurgedAt: Date | null;
  createdAt: Date;
  contactedAt: Date | null;
  repliedAt: Date | null;
  conversationId: string | null;
  convertedAt: Date | null;
  lastAutoContactAt: Date | null;
  followUpCount: number;
}

/** Pura: ¿ya hay una relación nuestra con este prospecto? */
export function hasOwnRelationship(lead: RetentionLeadState): boolean {
  return (
    lead.contactedAt !== null ||
    lead.repliedAt !== null ||
    lead.conversationId !== null ||
    lead.convertedAt !== null ||
    lead.lastAutoContactAt !== null ||
    lead.followUpCount > 0
  );
}

/** Pura: ¿toca purgar el contenido de Places de este lead? */
export function shouldPurgePlacesContent(lead: RetentionLeadState, now: Date): boolean {
  if (!lead.externalPlaceId || lead.placesPurgedAt) return false;
  if (hasOwnRelationship(lead)) return false;
  const fetchedAt = lead.placesFetchedAt ?? lead.createdAt;
  return fetchedAt < retentionCutoff(now);
}

export interface RetentionSweepResult {
  coordinatesCleared: number;
  leadsPurged: number;
  snapshotsPurged: number;
}

/**
 * El barrido del cron. Idempotente: lo ya purgado no vuelve a entrar, y
 * llamarlo de más no hace nada.
 */
export async function purgeExpiredPlacesContent(prisma: PrismaClient, now = new Date()): Promise<RetentionSweepResult> {
  const cutoff = retentionCutoff(now);
  const expired = { OR: [{ placesFetchedAt: { lt: cutoff } }, { placesFetchedAt: null, createdAt: { lt: cutoff } }] };

  // 1. Coordenadas, en todos los leads que vinieron de Places.
  const coords = await prisma.lead.updateMany({
    where: {
      externalPlaceId: { not: null },
      AND: [expired, { OR: [{ latitude: { not: null } }, { longitude: { not: null } }] }],
    },
    data: { latitude: null, longitude: null },
  });

  // 2. El resto, solo en los que nadie ha tocado. Por lotes, porque cada uno
  //    necesita su propia huella de teléfono.
  let leadsPurged = 0;
  for (;;) {
    const batch = await prisma.lead.findMany({
      where: {
        source: 'outbound',
        externalPlaceId: { not: null },
        placesPurgedAt: null,
        contactedAt: null,
        repliedAt: null,
        conversationId: null,
        convertedAt: null,
        lastAutoContactAt: null,
        followUpCount: 0,
        ...expired,
      },
      select: { id: true, contactPhone: true, phoneHash: true },
      take: 200,
    });
    if (batch.length === 0) break;
    for (const lead of batch) {
      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          phoneHash: lead.phoneHash ?? phoneHashOf(lead.contactPhone),
          contactName: null,
          contactPhone: null,
          website: null,
          summary: null,
          primaryType: null,
          latitude: null,
          longitude: null,
          placesPurgedAt: now,
        },
      });
      leadsPurged += 1;
    }
    if (batch.length < 200) break;
  }

  // 3. La foto de la zona.
  const snapshots = await prisma.prospectingCompetitorSnapshot.updateMany({
    where: { capturedAt: { lt: cutoff }, purgedAt: null },
    data: { subjectRating: null, subjectReviewCount: null, competitors: [], metrics: {}, purgedAt: now },
  });

  return { coordinatesCleared: coords.count, leadsPurged, snapshotsPurged: snapshots.count };
}

// -----------------------------------------------------------------------------
// Refresco en vivo
// -----------------------------------------------------------------------------

export interface RefreshedPlacesFields {
  contactName: string | null;
  contactPhone: string | null;
  website: string | null;
  summary: string | null;
  primaryType: string | null;
  latitude: number | null;
  longitude: number | null;
}

/** El texto que el barrido guarda en `summary` — el mismo de prospecting.ts. */
export function placesSummary(formattedAddress: string | null): string | null {
  return formattedAddress ? `Negocio encontrado en ${formattedAddress}.` : null;
}

/** Por qué Google ya no da el negocio: el place ID no existe (la ficha
 *  cambió o se retiró) o la ficha dice «cerrado definitivamente». Se guarda
 *  en Lead.placesUnavailable para decirlo en la ficha. */
export type PlacesUnavailableReason = 'not_found' | 'closed';

export type RefreshLeadResult =
  | { ok: true; fields: RefreshedPlacesFields; fromCache: boolean }
  | { ok: false; reason: 'lead_not_found' | 'no_place_id' | 'client_cap' | 'global_cap' | 'error' }
  | { ok: false; reason: PlacesUnavailableReason };

/** Pura: ¿el error de Places dice que ese negocio ya no existe en Google? */
export function isPlaceGone(status: number | undefined, error: string): boolean {
  if (status === 404) return true;
  // Un place ID retirado o mal formado vuelve como 400 INVALID_ARGUMENT.
  return status === 400 && /not.?found|invalid/i.test(error);
}

/** Pura: el mensaje que se enseña al cliente o al operador. */
export function refreshResultMessage(result: RefreshLeadResult): string {
  if (result.ok) return 'Datos actualizados desde Google.';
  switch (result.reason) {
    case 'not_found':
      return 'Google ya no encuentra este negocio: su ficha cambió o se retiró.';
    case 'closed':
      return 'En Google este negocio figura como cerrado definitivamente.';
    case 'client_cap':
      return `Has llegado al tope de ${CLIENT_DAILY_REFRESH_CAP} actualizaciones desde Google por hoy. Mañana se pueden volver a pedir.`;
    case 'global_cap':
      return 'Hoy ya no se pueden pedir más actualizaciones a Google. Mañana se pueden volver a pedir.';
    case 'no_place_id':
      return 'Este contacto no vino de Google: no hay nada que actualizar.';
    case 'lead_not_found':
      return 'No se ha encontrado ese contacto.';
    default:
      return 'Google no ha respondido. Prueba otra vez en un rato.';
  }
}

/** Pura: el código HTTP de cada resultado, el mismo en la ruta del cliente y
 *  en la del operador. 409 cuando Google dice que el negocio ya no está: la
 *  petición era buena, el negocio es el que ya no existe. */
export function refreshHttpStatus(result: RefreshLeadResult): number {
  if (result.ok) return 200;
  switch (result.reason) {
    case 'lead_not_found':
      return 404;
    case 'client_cap':
    case 'global_cap':
      return 429;
    case 'error':
      return 502;
    default:
      return 409;
  }
}

const refreshCache = new Map<string, { fields: RefreshedPlacesFields; at: number }>();

/** Solo para tests. */
export function resetPlacesRefreshState(): void {
  refreshCache.clear();
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Cuántos refrescos quedan hoy para este cliente y en total. */
export async function remainingRefreshesToday(
  prisma: PrismaClient,
  clientId: string,
  now = new Date(),
): Promise<{ client: number; global: number }> {
  const where = { action: { in: [...PLACES_REFRESH_ACTIONS] }, changedAt: { gte: startOfUtcDay(now) } };
  const [byClient, total] = await Promise.all([
    prisma.leadAudit.count({ where: { ...where, clientId } }),
    prisma.leadAudit.count({ where }),
  ]);
  return {
    client: Math.max(0, CLIENT_DAILY_REFRESH_CAP - byClient),
    global: Math.max(0, GLOBAL_DAILY_REFRESH_CAP - total),
  };
}

/**
 * Vuelve a pedir a Google el contenido de un lead por su place ID, lo guarda
 * y reabre los 30 días. `clientId` es la comprobación de propiedad: con él,
 * un lead de otro cliente es 'lead_not_found' (el portal lo saca de la
 * sesión, nunca del cuerpo de la petición). Cuenta contra los topes y deja
 * rastro en LeadAudit. Nunca lanza.
 */
export async function refreshLeadPlacesData(
  prisma: PrismaClient,
  params: { leadId: string; clientId?: string; actorId: string; now?: Date },
): Promise<RefreshLeadResult> {
  const now = params.now ?? new Date();
  try {
    const lead = await prisma.lead.findFirst({
      where: { id: params.leadId, ...(params.clientId ? { clientId: params.clientId } : {}) },
      select: { id: true, clientId: true, tenantId: true, externalPlaceId: true, status: true },
    });
    if (!lead) return { ok: false, reason: 'lead_not_found' };
    if (!lead.externalPlaceId) return { ok: false, reason: 'no_place_id' };

    const cached = refreshCache.get(lead.externalPlaceId);
    if (cached && now.getTime() - cached.at < REFRESH_CACHE_MS) {
      return { ok: true, fields: cached.fields, fromCache: true };
    }

    const left = await remainingRefreshesToday(prisma, lead.clientId, now);
    if (left.global <= 0) return { ok: false, reason: 'global_cap' };
    if (left.client <= 0) return { ok: false, reason: 'client_cap' };

    const audit = (action: (typeof PLACES_REFRESH_ACTIONS)[number]) =>
      prisma.leadAudit.create({
        data: {
          leadId: lead.id,
          clientId: lead.clientId,
          tenantId: lead.tenantId,
          action,
          statusBefore: lead.status,
          statusAfter: lead.status,
          actorId: params.actorId,
        },
      });

    const details = await getPlaceDetails(lead.externalPlaceId);
    if (!details.ok) {
      if (isPlaceGone(details.status, details.error)) {
        await prisma.lead.update({ where: { id: lead.id }, data: { placesUnavailable: 'not_found' } });
        await audit('places_unavailable');
        return { ok: false, reason: 'not_found' };
      }
      logError('places_retention.refresh_failed', new Error(details.error), { leadId: lead.id }, 'warn');
      return { ok: false, reason: 'error' };
    }
    if (details.data.businessStatus === 'CLOSED_PERMANENTLY') {
      await prisma.lead.update({ where: { id: lead.id }, data: { placesUnavailable: 'closed' } });
      await audit('places_unavailable');
      return { ok: false, reason: 'closed' };
    }

    const fields: RefreshedPlacesFields = {
      contactName: details.data.name || null,
      contactPhone: details.data.phoneNumber,
      website: details.data.websiteUri,
      summary: placesSummary(details.data.formattedAddress),
      primaryType: details.data.primaryType,
      latitude: details.data.latitude,
      longitude: details.data.longitude,
    };
    const hash = phoneHashOf(fields.contactPhone);
    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        ...fields,
        // Sin teléfono nuevo se conserva la huella que hubiera: una baja no
        // se olvida porque Google haya dejado de dar el número.
        ...(hash ? { phoneHash: hash } : {}),
        placesFetchedAt: now,
        placesPurgedAt: null,
        placesUnavailable: null,
      },
    });
    await audit('places_refreshed');
    refreshCache.set(lead.externalPlaceId, { fields, at: now.getTime() });
    return { ok: true, fields, fromCache: false };
  } catch (err) {
    logError('places_retention.refresh_error', err, { leadId: params.leadId }, 'warn');
    return { ok: false, reason: 'error' };
  }
}

/** Lo que usan la lista diaria de llamadas y el informe del operador: los
 *  datos frescos o null. */
export async function refreshLeadFromPlaces(
  prisma: PrismaClient,
  lead: { id: string; externalPlaceId: string | null },
  now = new Date(),
): Promise<RefreshedPlacesFields | null> {
  if (!lead.externalPlaceId) return null;
  const result = await refreshLeadPlacesData(prisma, { leadId: lead.id, actorId: 'system:places-refresh', now });
  return result.ok ? result.fields : null;
}

/** El operador: refresca los caducados de un cliente hasta agotar el tope
 *  del día. Devuelve cuántos se actualizaron y cuántos ya no existen. */
export async function refreshExpiredLeadsForClient(
  prisma: PrismaClient,
  params: { clientId: string; actorId: string; now?: Date },
): Promise<{ refreshed: number; unavailable: number; failed: number; stoppedAtCap: boolean }> {
  const leads = await prisma.lead.findMany({
    where: {
      clientId: params.clientId,
      placesPurgedAt: { not: null },
      externalPlaceId: { not: null },
      placesUnavailable: null,
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
    take: CLIENT_DAILY_REFRESH_CAP,
  });
  let refreshed = 0;
  let unavailable = 0;
  let failed = 0;
  let stoppedAtCap = false;
  for (const lead of leads) {
    const result = await refreshLeadPlacesData(prisma, {
      leadId: lead.id,
      clientId: params.clientId,
      actorId: params.actorId,
      now: params.now,
    });
    if (result.ok) refreshed += 1;
    else if (result.reason === 'not_found' || result.reason === 'closed') unavailable += 1;
    else if (result.reason === 'client_cap' || result.reason === 'global_cap') {
      stoppedAtCap = true;
      break;
    } else failed += 1;
  }
  return { refreshed, unavailable, failed, stoppedAtCap };
}

