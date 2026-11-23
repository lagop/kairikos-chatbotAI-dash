import { createHash, randomBytes } from 'node:crypto';

// =============================================================================
// Reseñas en la web Premium (23/11/2026) — las reglas del feed, puras: sin
// base de datos ni red. Las usan lib/review-feed.ts, la ruta pública y sus
// tests.
//
// El feed lo lee la build de la web del cliente (plantillas dental, estética y
// hotel de Kairikos Web Premium) cada noche, desde su .github/workflows/
// publicar.yml, nunca el navegador. El formato es el de docs/resenas.md de la
// plantilla dental, que las tres comparten:
//
//   { version: 1, syncedAt, writeUrl?, topics: [], reviews: [{ id, author,
//     rating, date, lang, text?: { [lang]: … }, reply?: { date, text }, featured }] }
//
// v1 sin IA: el texto original en su idioma, sin traducciones, temas, resumen
// ni tratamiento (los campos que la plantilla acepta como opcionales). Se
// publican TODAS las reseñas que siguen en Google, también las de 1 y 2
// estrellas: elegir cuáles salen sería engañoso (Directiva Ómnibus).
// =============================================================================

export const REVIEW_FEED_VERSION = 1;

/** rsf_ + 18 bytes en base64url: 144 bits de azar. */
const TOKEN_RE = /^rsf_[A-Za-z0-9_-]{24}$/;

export function generateReviewFeedToken(): string {
  return `rsf_${randomBytes(18).toString('base64url')}`;
}

export function isReviewFeedTokenShape(token: string): boolean {
  return TOKEN_RE.test(token);
}

/** Solo se guarda el hash. Con 144 bits de azar basta un SHA-256 sin sal. */
export function hashReviewFeedToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** La URL que va en el secreto REVIEWS_FEED_URL del repositorio de la web. */
export function reviewFeedUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/public/resenas/${token}/feed`;
}

// --- Texto ---------------------------------------------------------------------

const TRANSLATED = '(Translated by Google)';
const ORIGINAL = '(Original)';

/**
 * Google devuelve a veces el comentario con su traducción automática pegada:
 *   «(Translated by Google) <traducción>\n\n(Original)\n<original>»  o
 *   «<original>\n\n(Translated by Google)\n<traducción>».
 * La web publica solo el original, el texto que escribió el autor.
 */
export function originalText(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let text = raw;
  const o = text.indexOf(ORIGINAL);
  if (text.trimStart().startsWith(TRANSLATED) && o !== -1) {
    text = text.slice(o + ORIGINAL.length);
  } else {
    const t = text.indexOf(TRANSLATED);
    if (t > 0) text = text.slice(0, t);
  }
  text = text.trim();
  return text.length > 0 ? text : null;
}

// --- Idioma --------------------------------------------------------------------

export const FEED_LANGS = ['es', 'en', 'de'] as const;
export type FeedLang = (typeof FEED_LANGS)[number];

// Palabras frecuentes y propias de cada idioma (sin las que comparten: «a»,
// «en», «die»…). Basta para las reseñas de una clínica o un hotel; lo que no
// se decide cae en el idioma principal de la web.
const STOPWORDS: Record<FeedLang, ReadonlySet<string>> = {
  es: new Set('el la los las que del por para con una muy pero como más todo todos nos está están fue han ha hemos es son mi gracias trato atención siempre también sin'.split(' ')),
  en: new Set('the and was were with very they we our my you this that have has are for great staff would really always thank thanks friendly'.split(' ')),
  de: new Set('und der das ist nicht mit sehr wir ich sie war waren auch für ein eine einen zu den dem sind haben hat immer vielen dank freundlich'.split(' ')),
};

export function detectLang(text: string, fallback: FeedLang = 'es'): FeedLang {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  let best: FeedLang = fallback;
  let bestScore = 0;
  let tie = false;
  for (const lang of FEED_LANGS) {
    const score = words.reduce((n, w) => n + (STOPWORDS[lang].has(w) ? 1 : 0), 0);
    if (score > bestScore) {
      best = lang;
      bestScore = score;
      tie = false;
    } else if (score === bestScore && score > 0) {
      tie = true;
    }
  }
  return bestScore === 0 || tie ? fallback : best;
}

// --- Autor ---------------------------------------------------------------------

/**
 * Nombre de pila e inicial («Marta García López» → «Marta G.»), como pide la
 * plantilla. El nombre completo ya es público en Google, pero la web no
 * necesita más. Sin nombre (o el «A Google User» de las anónimas), «Anónimo».
 */
export function shortAuthor(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || /^a google user$/i.test(parts.join(' '))) return 'Anónimo';
  if (parts.length === 1) return parts[0];
  const initial = [...parts[1]][0];
  return `${parts[0]} ${initial.toUpperCase()}.`;
}

// --- El feed -------------------------------------------------------------------

export interface FeedReviewRow {
  googleReviewId: string;
  reviewerName: string | null;
  starRating: number;
  comment: string | null;
  createTime: Date;
  updateTime: Date;
  replyComment: string | null;
  replyUpdatedAt: Date | null;
  removedAt: Date | null;
}

export interface FeedReview {
  id: string;
  author: string;
  rating: number;
  date: string;
  lang: FeedLang;
  text?: Partial<Record<FeedLang, string>>;
  reply?: { date: string; text: Partial<Record<FeedLang, string>> };
  featured: false;
}

export interface ReviewFeed {
  version: typeof REVIEW_FEED_VERSION;
  syncedAt: string | null;
  writeUrl?: string;
  topics: [];
  reviews: FeedReview[];
}

/** El id público: el último tramo del nombre de Google, sin la cuenta ni la ficha. */
export function publicReviewId(googleReviewId: string): string {
  const parts = googleReviewId.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? googleReviewId;
}

export function buildReviewFeed(
  rows: readonly FeedReviewRow[],
  opts: { syncedAt: Date | null; writeUrl: string | null; defaultLang?: FeedLang },
): ReviewFeed {
  const fallback = opts.defaultLang ?? 'es';
  const reviews = rows
    // Las que ya no están en Google no se publican; una valoración sin
    // estrellas válidas (el mapa de google-review-sync.ts da 0) tampoco.
    .filter((r) => r.removedAt === null && Number.isInteger(r.starRating) && r.starRating >= 1 && r.starRating <= 5)
    .slice()
    .sort((a, b) => b.createTime.getTime() - a.createTime.getTime())
    .map((r): FeedReview => {
      const text = originalText(r.comment);
      const lang = text ? detectLang(text, fallback) : fallback;
      const reply = originalText(r.replyComment);
      return {
        id: publicReviewId(r.googleReviewId),
        author: shortAuthor(r.reviewerName),
        rating: r.starRating,
        date: r.createTime.toISOString(),
        lang,
        // Sin comentario = solo estrellas: cuenta en la media, no sale como tarjeta.
        ...(text ? { text: { [lang]: text } } : {}),
        ...(text && reply ? { reply: { date: (r.replyUpdatedAt ?? r.updateTime).toISOString(), text: { [lang]: reply } } } : {}),
        featured: false,
      };
    });

  let writeUrl: string | undefined;
  if (opts.writeUrl) {
    try {
      writeUrl = new URL(opts.writeUrl).protocol === 'https:' ? opts.writeUrl : undefined;
    } catch {
      writeUrl = undefined;
    }
  }

  return {
    version: REVIEW_FEED_VERSION,
    syncedAt: opts.syncedAt?.toISOString() ?? null,
    ...(writeUrl ? { writeUrl } : {}),
    topics: [],
    reviews,
  };
}

// --- La salud de la web ---------------------------------------------------------

/** La web se reconstruye cada noche: si no ha leído el feed en 36 horas, la
 *  publicación nocturna está fallando (o el secreto no está puesto). */
export const FEED_STALE_AFTER_MS = 36 * 60 * 60_000;

export type WebFeedState = 'sin_enlace' | 'sin_leer' | 'al_dia' | 'atrasada';

export function webFeedState(input: { hasToken: boolean; readAt: Date | null }, now: Date): WebFeedState {
  if (!input.hasToken) return 'sin_enlace';
  if (!input.readAt) return 'sin_leer';
  return now.getTime() - input.readAt.getTime() > FEED_STALE_AFTER_MS ? 'atrasada' : 'al_dia';
}
