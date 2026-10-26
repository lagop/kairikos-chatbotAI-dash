// =============================================================================
// 26/10/2026 — las reseñas, las citas y el horario del borrador de web (A11).
//
// Funciones puras y sin 'server-only': las usan el render, el barrido y la
// IA, y se prueban sin red ni base de datos.
//
// De dónde sale esto: la demo hecha a mano para Fontanería Suárez (5,0 en 17
// reseñas). El borrador automático de ese mismo negocio no enseñaba ni una
// estrella ni un horario, y su titular era «servicio de fontanería en Las
// Palmas». La demo sacó el titular de lo que repetían sus clientes («localiza
// la avería sin romper») y eso es lo que separa una plantilla de SU web.
//
// Tres reglas que se aplican aquí y no en cada sitio que pinta reseñas:
//
// 1. Solo reseñas de 4 y 5 estrellas con texto. Es una propuesta de venta, y
//    nada de lo que se enseña al dueño puede sonar a argumento en contra (la
//    misma regla que el «nunca un cero» de /prospeccion/). Y se dice así en
//    la página: las políticas de Places obligan a explicar cómo se filtran.
// 2. Nunca la de alguien que comparte apellido con el negocio. «Maria
//    Suárez» reseñando a «Fontanería Suárez» es, con toda probabilidad,
//    familia, y enseñarla como prueba social es lo primero que el dueño
//    detecta.
// 3. El autor firma con nombre e inicial («Víctor H.»), enlazado a su perfil
//    de Google: atribución sin exponer el apellido completo de un tercero en
//    una página que se reenvía por WhatsApp.
//
// Y una que no se ve: el texto de las reseñas NUNCA se guarda (las
// condiciones de Google solo dejan guardar el place ID). Las citas de la
// banda «Lo que repiten sus clientes» se guardan como referencia a la reseña
// más su posición dentro del texto y una huella; el texto se vuelve a pedir
// al pintar. Si la reseña cambió o desapareció, la cita se cae sola.
// =============================================================================

import type { PlaceReview } from './google-places';

export interface DraftReview {
  /** El `name` de Google de la reseña. */
  ref: string;
  rating: number;
  text: string;
  translated: boolean;
  /** «Víctor H.» */
  author: string;
  authorUri: string | null;
  relativeTime: string | null;
}

/** Una cita tal como se guarda en el borrador: sin el texto de la reseña. */
export interface StoredHighlight {
  title: string;
  reviewRef: string;
  start: number;
  length: number;
  /** Huella del fragmento citado, para saber si sigue siendo el mismo. */
  hash: string;
}

/** Una cita lista para pintar. */
export interface RenderHighlight {
  title: string;
  quote: string;
  author: string;
}

export const MAX_HIGHLIGHTS = 4;
const MIN_QUOTE_CHARS = 8;
const MAX_QUOTE_CHARS = 160;
const MAX_TITLE_CHARS = 48;

/** Minúsculas y sin tildes, para comparar nombres. */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function words(value: string): string[] {
  return fold(value)
    .split(/[^a-z0-9ñ]+/)
    .filter(Boolean);
}

/** «Víctor Hernández García» → «Víctor H.». Una sola palabra se deja tal cual. */
export function shortAuthorName(name: string | null): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Cliente de Google';
  if (parts.length === 1) return parts[0];
  const initial = parts[1].charAt(0).toLocaleUpperCase('es-ES');
  return `${parts[0]} ${initial}.`;
}

/**
 * ¿Algún apellido del autor aparece en el nombre del negocio? Se miran las
 * palabras del autor a partir de la segunda (la primera es el nombre de pila)
 * y solo las de tres letras o más, para que un «de» o un «Gil» abreviado no
 * tumben reseñas por casualidad.
 */
export function sharesSurname(authorName: string | null, businessName: string): boolean {
  const surnames = words(authorName ?? '')
    .slice(1)
    .filter((w) => w.length >= 3);
  if (surnames.length === 0) return false;
  const business = new Set(words(businessName));
  return surnames.some((s) => business.has(s));
}

export function filterDraftReviews(reviews: ReadonlyArray<PlaceReview>, businessName: string): DraftReview[] {
  return reviews
    .filter((r) => r.rating !== null && r.rating >= 4)
    .filter((r) => r.text.trim().length > 0)
    .filter((r) => !sharesSurname(r.authorName, businessName))
    .map((r) => ({
      ref: r.name,
      rating: r.rating ?? 5,
      text: r.text.trim(),
      translated: r.translated,
      author: shortAuthorName(r.authorName),
      authorUri: r.authorUri,
      relativeTime: r.relativeTime,
    }));
}

/** FNV-1a de 32 bits en hexadecimal. No es seguridad: es una huella barata
 *  para comprobar que el fragmento citado sigue diciendo lo mismo. */
export function quoteHash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Quita las comillas y los puntos suspensivos que el modelo añade alrededor. */
function trimQuote(value: string): string {
  return value
    .trim()
    .replace(/^[«"“'‘\s]+/, '')
    .replace(/[»"”'’\s]+$/, '')
    .replace(/^(\.\.\.|…)\s*/, '')
    .replace(/\s*(\.\.\.|…)$/, '')
    .trim();
}

/**
 * Convierte las citas que propone el modelo en citas guardables, o las tira.
 *
 * Una cita solo sobrevive si es LITERAL: el fragmento tiene que aparecer tal
 * cual dentro de la reseña que dice citar. Es la regla que impide que la IA
 * ponga en boca de un cliente algo que no dijo — en la página del propio
 * negocio y con el nombre de la persona debajo.
 *
 * `raw` es lo que vino en el JSON (sin validar); `reviews` es la lista que se
 * le pasó al modelo, numerada desde 1.
 */
export function resolveHighlights(raw: unknown, reviews: ReadonlyArray<DraftReview>): StoredHighlight[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredHighlight[] = [];
  const seenTitles = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_HIGHLIGHTS) break;
    const entry = item as Record<string, unknown> | null;
    const title = typeof entry?.title === 'string' ? entry.title.trim().slice(0, MAX_TITLE_CHARS) : '';
    const index = Number(entry?.review);
    const quote = typeof entry?.quote === 'string' ? trimQuote(entry.quote) : '';
    if (title.length < 3 || !Number.isInteger(index) || index < 1 || index > reviews.length) continue;
    if (quote.length < MIN_QUOTE_CHARS || quote.length > MAX_QUOTE_CHARS) continue;
    const review = reviews[index - 1];
    const start = review.text.indexOf(quote);
    if (start < 0) continue;
    const key = fold(title);
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    out.push({ title, reviewRef: review.ref, start, length: quote.length, hash: quoteHash(quote) });
  }
  return out;
}

/**
 * Las citas guardadas, con el texto recién pedido a Google. Una cita cuya
 * reseña ya no está, o cuyo fragmento ya no coincide, no se pinta.
 */
export function renderableHighlights(
  stored: ReadonlyArray<StoredHighlight> | null | undefined,
  reviews: ReadonlyArray<DraftReview>,
): RenderHighlight[] {
  if (!stored) return [];
  const byRef = new Map(reviews.map((r) => [r.ref, r]));
  const out: RenderHighlight[] = [];
  for (const h of stored) {
    const review = byRef.get(h.reviewRef);
    if (!review) continue;
    const quote = review.text.slice(h.start, h.start + h.length);
    if (quote.length !== h.length || quoteHash(quote) !== h.hash) continue;
    out.push({ title: h.title, quote, author: review.author });
  }
  return out;
}

export interface OpeningHoursRow {
  days: string;
  hours: string;
}

const DAY_ORDER = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

function capitalize(value: string): string {
  return value.charAt(0).toLocaleUpperCase('es-ES') + value.slice(1);
}

/**
 * «lunes: 8:00–20:00» × 7 → [{ días: 'Lunes a domingo', horas: '8:00–20:00' }].
 * Agrupa los días seguidos con el mismo horario. Lo que no entienda lo deja
 * fuera: un horario mal leído en la web de un negocio es peor que ninguno.
 */
export function groupOpeningHours(descriptions: ReadonlyArray<string>): OpeningHoursRow[] {
  const parsed = descriptions
    .map((line) => {
      const i = line.indexOf(':');
      if (i < 0) return null;
      const day = line.slice(0, i).trim().toLocaleLowerCase('es-ES');
      const hours = line.slice(i + 1).trim();
      return DAY_ORDER.includes(day) && hours ? { day, hours } : null;
    })
    .filter((d): d is { day: string; hours: string } => d !== null);
  if (parsed.length !== 7) return [];

  const rows: OpeningHoursRow[] = [];
  let i = 0;
  while (i < parsed.length) {
    let j = i;
    while (j + 1 < parsed.length && parsed[j + 1].hours === parsed[i].hours) j += 1;
    const days = i === j ? capitalize(parsed[i].day) : `${capitalize(parsed[i].day)} a ${parsed[j].day}`;
    rows.push({ days, hours: parsed[i].hours });
    i = j + 1;
  }
  return rows;
}

/** La línea de la portada, solo cuando el horario es el mismo los siete días.
 *  Con horarios partidos la portada no resume nada: lo cuenta la sección. */
export function openEveryDaySummary(rows: ReadonlyArray<OpeningHoursRow>): string | null {
  if (rows.length !== 1) return null;
  const hours = rows[0].hours;
  if (/cerrado/i.test(hours)) return null;
  if (/24 horas/i.test(hours)) return 'Abierto las 24 horas, todos los días';
  return `Abierto los 7 días, ${hours}`;
}
