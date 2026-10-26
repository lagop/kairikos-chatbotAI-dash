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

/** Tope de refrescos al día entre todos los llamantes: cada uno es un Place
 *  Details Enterprise (teléfono y web), 20 $ por 1.000 pasado el cupo
 *  gratuito. Con la lista diaria de 15 sobra con creces. */
export const DAILY_REFRESH_CAP = 40;
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

const refreshCache = new Map<string, { fields: RefreshedPlacesFields | null; at: number }>();
let refreshDay = '';
let refreshesToday = 0;

/** Solo para tests. */
export function resetPlacesRefreshState(): void {
  refreshCache.clear();
  refreshDay = '';
  refreshesToday = 0;
}

/**
 * Vuelve a pedir a Google el contenido de un lead purgado (o viejo) y lo
 * guarda con una ventana nueva de 30 días. Null si no se pudo: sin clave,
 * tope del día agotado, error de Google o negocio cerrado para siempre.
 * Nunca lanza.
 */
export async function refreshLeadFromPlaces(
  prisma: PrismaClient,
  lead: { id: string; externalPlaceId: string | null },
  now = new Date(),
): Promise<RefreshedPlacesFields | null> {
  if (!lead.externalPlaceId) return null;
  const cached = refreshCache.get(lead.externalPlaceId);
  if (cached && now.getTime() - cached.at < REFRESH_CACHE_MS) return cached.fields;

  const day = now.toISOString().slice(0, 10);
  if (day !== refreshDay) {
    refreshDay = day;
    refreshesToday = 0;
  }
  if (refreshesToday >= DAILY_REFRESH_CAP) return null;
  refreshesToday += 1;

  try {
    const details = await getPlaceDetails(lead.externalPlaceId);
    if (!details.ok) {
      logError('places_retention.refresh_failed', new Error(details.error), { leadId: lead.id }, 'warn');
      return null;
    }
    let fields: RefreshedPlacesFields | null = null;
    if (details.data.businessStatus !== 'CLOSED_PERMANENTLY') {
      fields = {
        contactName: details.data.name || null,
        contactPhone: details.data.phoneNumber,
        website: details.data.websiteUri,
        summary: placesSummary(details.data.formattedAddress),
        primaryType: details.data.primaryType,
        latitude: details.data.latitude,
        longitude: details.data.longitude,
      };
      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          ...fields,
          // Sin teléfono nuevo se conserva la huella que hubiera: una baja
          // no se olvida porque Google haya dejado de dar el número.
          ...(phoneHashOf(fields.contactPhone) ? { phoneHash: phoneHashOf(fields.contactPhone) } : {}),
          placesFetchedAt: now,
          placesPurgedAt: null,
        },
      });
    }
    refreshCache.set(lead.externalPlaceId, { fields, at: now.getTime() });
    return fields;
  } catch (err) {
    logError('places_retention.refresh_error', err, { leadId: lead.id }, 'warn');
    return null;
  }
}
