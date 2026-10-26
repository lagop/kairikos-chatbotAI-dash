import 'server-only';
import { getPlaceDraftData, type PlaceDraftData } from './google-places';
import { logError } from './observability';

// =============================================================================
// 26/10/2026 — los datos de Google de un borrador, pedidos en el momento.
//
// Por qué en vivo y no guardados: las condiciones de Google Maps Platform
// solo dejan guardar el place ID (sin plazo) y la latitud y la longitud (30
// días). La valoración, el recuento, el horario, las reseñas y la dirección
// no. Por eso el borrador de Fontanería Suárez seguía enseñando «C. Violeta,
// 20» cuando el negocio ya estaba en C. Camelia, 50: la dirección se copió a
// Lead.summary el día que el barrido lo encontró y nunca se volvió a mirar.
//
// La pregunta «¿cada cuántos días se refresca?» tiene aquí respuesta corta:
// nunca se enseña nada de Google con más de una hora. Es más estricto que
// cualquier plazo en días, y es lo que piden las condiciones.
//
// Lo que cuesta: cada consulta es un Place Details Enterprise + Atmosphere
// (25 $ por 1.000; 1.000 gratis al mes). Dos frenos, porque /borrador es un
// enlace público que cualquiera puede recargar:
//
//   1. Caché en memoria de UNA HORA por place ID. Cien recargas seguidas del
//      mismo enlace son una consulta. Es memoria del proceso y se pierde al
//      desplegar: es una caché de cortesía, no un almacén.
//   2. Tope de DAILY_LIVE_LOOKUP_CAP consultas al día entre todos los
//      borradores (≈ 2,5 $/día como máximo). Pasado el tope, el borrador se
//      pinta sin las secciones de Google — sin estrellas, horario ni reseñas,
//      con la dirección guardada —, nunca roto.
//
// El contador también vive en memoria. Con un solo contenedor basta; con
// varios, el tope sería por contenedor, y está escrito aquí para que no
// sorprenda.
// =============================================================================

export const LIVE_CACHE_TTL_MS = 60 * 60 * 1000;
export const DAILY_LIVE_LOOKUP_CAP = 100;

interface CacheEntry {
  data: PlaceDraftData;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
let counterDay = '';
let lookupsToday = 0;

function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Pura: ¿sigue valiendo lo cacheado? */
export function isLiveEntryFresh(fetchedAt: number, now: number): boolean {
  return now - fetchedAt < LIVE_CACHE_TTL_MS;
}

/** Solo para tests. */
export function resetWebDraftLiveCache(): void {
  cache.clear();
  counterDay = '';
  lookupsToday = 0;
}

/**
 * Los datos públicos de Google del negocio, o null si no hay place ID, si se
 * acabó el cupo del día o si Google falla. Nunca lanza: quien llama pinta el
 * borrador igual, sin esas secciones.
 */
export async function getLiveDraftData(
  placeId: string | null | undefined,
  now: Date = new Date(),
): Promise<PlaceDraftData | null> {
  if (!placeId) return null;

  const hit = cache.get(placeId);
  if (hit && isLiveEntryFresh(hit.fetchedAt, now.getTime())) return hit.data;

  const today = dayKey(now);
  if (counterDay !== today) {
    counterDay = today;
    lookupsToday = 0;
  }
  if (lookupsToday >= DAILY_LIVE_LOOKUP_CAP) return null;
  lookupsToday += 1;

  try {
    const result = await getPlaceDraftData(placeId);
    if (!result.ok) {
      logError('web_draft_live.lookup_failed', new Error(result.error), { placeId }, 'warn');
      return null;
    }
    cache.set(placeId, { data: result.data, fetchedAt: now.getTime() });
    // La caché no crece sin límite: se barren las caducadas de paso.
    if (cache.size > 500) {
      for (const [key, entry] of cache) {
        if (!isLiveEntryFresh(entry.fetchedAt, now.getTime())) cache.delete(key);
      }
    }
    return result.data;
  } catch (err) {
    logError('web_draft_live.lookup_threw', err, { placeId }, 'warn');
    return null;
  }
}
