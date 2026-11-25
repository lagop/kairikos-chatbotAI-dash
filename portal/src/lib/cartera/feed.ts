import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { alquilerFeedSchema, panoSchema, photoSchema, ventaFeedSchema, type Feed } from './schema';

// Los tipos se sacan aquí y no en schema.ts: aquel archivo es una copia literal
// del de la plantilla web y no se edita.
export const FEED_VERSION = 1;
export type FeedPhoto = z.infer<typeof photoSchema>;
export type FeedPano = z.infer<typeof panoSchema>;
// `panos` es opcional en lo que sale: sin fotos 360° la casa va sin el campo (withoutEmptyPanos).
export type VentaFeedItem = Omit<z.infer<typeof ventaFeedSchema>, 'panos'> & { panos?: FeedPano[] };
export type AlquilerFeedItem = Omit<z.infer<typeof alquilerFeedSchema>, 'panos'> & { panos?: FeedPano[] };
/** El feed tal como sale del portal: el envoltorio de feedSchema con cada casa ya validada. */
export type CarteraFeed = Omit<Feed, 'ventas' | 'alquileres'> & { ventas: VentaFeedItem[]; alquileres: AlquilerFeedItem[] };

// =============================================================================
// Cartera — el feed que lee el build de la web (GET /api/public/cartera/<token>/feed).
//
// Reglas puras, sin base de datos: qué casa es publicable y cómo se monta cada
// una. La ruta reúne las filas y llama aquí.
//
// Solo entran las casas publicables: no las que están en borrador ni las que
// tienen errores (sin certificado energético, por ejemplo). Las vendidas y
// alquiladas sí, con su estado: la web las saca de los listados y mantiene su
// ficha, para no romper enlaces ya compartidos.
//
// Además de `errors`, cada casa se vuelve a validar aquí contra el esquema
// (estricto: un campo de más también es un error) antes de salir. Con PORTFOLIO_REQUIRED=1 la web PARA el build si el feed no
// valida (nunca publica una cartera a medias), así que una sola casa con un
// `data` que se coló sin pasar por la validación del panel tumbaría todas las
// publicaciones. Se queda fuera esa casa, no la web entera.
// =============================================================================

export interface FeedPhotoRow {
  id: string;
  width: number;
  height: number;
  position: number;
  alt: unknown;
}

/** Una foto 360° (CarteraPano): como una foto, sin texto alternativo. */
export interface FeedPanoRow {
  id: string;
  width: number;
  height: number;
  position: number;
}

export interface FeedHomeRow {
  ref: string;
  operation: string;
  status: string;
  data: unknown;
  errors: unknown;
  photos: readonly FeedPhotoRow[];
  panos?: readonly FeedPanoRow[];
}

/** Publicable: no es un borrador y no tiene errores pendientes. */
export function isPublishable(home: { status: string; errors: unknown }): boolean {
  if (home.status === 'borrador') return false;
  if (home.errors === null || home.errors === undefined) return true;
  // [] (o {}) es «ya no quedan errores»: el panel puede dejarlo así al corregir.
  if (Array.isArray(home.errors)) return home.errors.length === 0;
  if (typeof home.errors === 'object') return Object.keys(home.errors as object).length === 0;
  return false;
}

/** La URL pública de una foto: por id, que no se puede adivinar. */
export function photoUrl(baseUrl: string, photoId: string): string {
  return `${baseUrl}/api/public/cartera/foto/${photoId}`;
}

/** El texto alternativo es parcial en el formato: solo los idiomas que tienen texto. */
function toAlt(value: unknown): FeedPhoto['alt'] {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const alt: FeedPhoto['alt'] = {};
  for (const lang of ['es', 'en', 'de'] as const) {
    const text = v[lang];
    if (typeof text === 'string' && text.trim()) alt[lang] = text;
  }
  return alt;
}

export function feedPhotos(baseUrl: string, photos: readonly FeedPhotoRow[]): FeedPhoto[] {
  return [...photos]
    .sort((a, b) => a.position - b.position)
    .map((p) => ({ url: photoUrl(baseUrl, p.id), width: p.width, height: p.height, alt: toAlt(p.alt) }));
}

/** Las fotos 360°, por orden y con la misma URL pública que las fotos: la web
 *  casa cada una con su estancia (`panoRooms`) por el último segmento, el id. */
export function feedPanos(baseUrl: string, panos: readonly FeedPanoRow[]): FeedPano[] {
  return [...panos].sort((a, b) => a.position - b.position).map((p) => ({ url: photoUrl(baseUrl, p.id), width: p.width, height: p.height }));
}

/**
 * Sin fotos 360°, la casa sale sin el campo. El esquema lo rellena con `[]`
 * (default), pero `panos` llegó al formato el 25/11/2026 sin cambiar de
 * versión: una web construida con el esquema anterior (estricto) pararía el
 * build con un `panos: []` que no conoce. Así, el feed de una cartera sin
 * fotos 360° sigue siendo el de antes byte a byte (y su ETag, el mismo).
 */
function withoutEmptyPanos<T extends { panos?: unknown[] }>(home: T): T {
  if (Array.isArray(home.panos) && home.panos.length === 0) {
    const { panos: _panos, ...rest } = home;
    return rest as T;
  }
  return home;
}

export interface SkippedHome {
  ref: string;
  reason: 'invalid';
}

export interface BuiltFeed {
  feed: CarteraFeed;
  /** Casas publicables que no validaron y se quedaron fuera. Sin datos personales. */
  skipped: SkippedHome[];
  /** Huella del contenido (sin generatedAt), para el ETag. */
  etag: string;
}

export function buildFeed(homes: readonly FeedHomeRow[], opts: { baseUrl: string; now?: Date }): BuiltFeed {
  const ventas: VentaFeedItem[] = [];
  const alquileres: AlquilerFeedItem[] = [];
  const skipped: SkippedHome[] = [];

  const ordered = [...homes].sort((a, b) => a.ref.localeCompare(b.ref, 'en'));
  for (const home of ordered) {
    if (!isPublishable(home)) continue;
    const data = home.data && typeof home.data === 'object' && !Array.isArray(home.data) ? (home.data as Record<string, unknown>) : {};
    // La referencia y el estado son los de las columnas: son los que el panel
    // enseña y los que se auditan; el JSON no puede contradecirlos.
    // Las fotos son siempre las de CarteraPhoto, nunca un `photos` que se colara
    // en el JSON; las fotos 360°, las de CarteraPano.
    const candidate = { ...data, ref: home.ref, status: home.status, photos: feedPhotos(opts.baseUrl, home.photos), panos: feedPanos(opts.baseUrl, home.panos ?? []) };
    if (home.operation === 'venta') {
      const parsed = ventaFeedSchema.safeParse(candidate);
      if (parsed.success) ventas.push(withoutEmptyPanos(parsed.data));
      else skipped.push({ ref: home.ref, reason: 'invalid' });
    } else if (home.operation === 'alquiler') {
      const parsed = alquilerFeedSchema.safeParse(candidate);
      if (parsed.success) alquileres.push(withoutEmptyPanos(parsed.data));
      else skipped.push({ ref: home.ref, reason: 'invalid' });
    }
  }

  const etag = `"${createHash('sha256').update(JSON.stringify({ v: FEED_VERSION, ventas, alquileres })).digest('hex').slice(0, 32)}"`;
  return {
    feed: { version: FEED_VERSION, generatedAt: (opts.now ?? new Date()).toISOString(), ventas, alquileres },
    skipped,
    etag,
  };
}

/** If-None-Match puede traer varias etiquetas, o débiles (W/"…"). */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === '*') return true;
  return ifNoneMatch.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag);
}
