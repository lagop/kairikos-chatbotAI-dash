import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { alquilerFeedSchema, photoSchema, ventaFeedSchema, type Feed } from './schema';

// Los tipos se sacan aquí y no en schema.ts: aquel archivo es una copia literal
// del de la plantilla web y no se edita.
export const FEED_VERSION = 1;
export type FeedPhoto = z.infer<typeof photoSchema>;
export type VentaFeedItem = z.infer<typeof ventaFeedSchema>;
export type AlquilerFeedItem = z.infer<typeof alquilerFeedSchema>;
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

export interface FeedHomeRow {
  ref: string;
  operation: string;
  status: string;
  data: unknown;
  errors: unknown;
  photos: readonly FeedPhotoRow[];
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
    // Las fotos son siempre las de CarteraPhoto, nunca un `photos` que se colara en el JSON.
    const candidate = { ...data, ref: home.ref, status: home.status, photos: feedPhotos(opts.baseUrl, home.photos) };
    if (home.operation === 'venta') {
      const parsed = ventaFeedSchema.safeParse(candidate);
      if (parsed.success) ventas.push(parsed.data);
      else skipped.push({ ref: home.ref, reason: 'invalid' });
    } else if (home.operation === 'alquiler') {
      const parsed = alquilerFeedSchema.safeParse(candidate);
      if (parsed.success) alquileres.push(parsed.data);
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
