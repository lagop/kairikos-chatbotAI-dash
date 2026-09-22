import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { applyLeadEnrichment } from './leads';
import { logError } from './observability';
import { safeFetch, BlockedUrlError } from './safe-fetch';

// =============================================================================
// Prospección con IA, Fase B — website enrichment. Para cada Lead outbound
// del que Google Places dio una web, el portal la rastrea y saca de ahí el
// email y el teléfono de contacto.
//
// Fase 1.4 — hasta aquí, el texto rastreado se empujaba a n8n para que un
// LLM extrajera los contactos y llamara de vuelta a
// PATCH /api/internal/leads/[id]/enrich. Ese workflow no existía, así que
// el enriquecimiento no ocurría nunca. Ahora la extracción es local y
// DETERMINISTA, no un LLM:
//
//   Un email y un teléfono son formatos regulares. Una expresión regular
//   los encuentra gratis, sin latencia, y —lo que de verdad importa— no
//   puede inventarse un teléfono que no estaba en la página. En un
//   producto que luego CONTACTA automáticamente por WhatsApp, un número
//   alucinado no es un fallo cosmético: es un mensaje a un desconocido.
//   Por eso aquí no hay modelo que valga.
//
// La ruta del callback sigue existiendo y funcionando por si alguna vez
// hay una fuente externa; simplemente ya no es el camino principal.
//
// Un intento por lead (Lead.enrichmentRequestedAt), no una máquina de
// reintentos: una web caída suele ser un hecho estable, no algo
// transitorio, así que se registra y se deja en paz en vez de reintentarlo
// en cada tick para siempre. Lo mismo si la página no tenía ningún
// contacto: el texto no va a cambiar por volver a mirarlo mañana.
// =============================================================================

const CRAWL_TIMEOUT_MS = 8_000;
const MAX_RAW_TEXT_CHARS = 20_000;
/** Cap per cron tick — bounds how many third-party site fetches one
 *  prospecting-tick invocation can block on; a persistently slow site
 *  costs at most CRAWL_TIMEOUT_MS, not the whole tick. */
export const ENRICHMENT_BATCH_SIZE = 20;

const USER_AGENT = 'Mozilla/5.0 (compatible; KairikosProspectingBot/1.0; +https://kairikos.com)';

export type CrawlWebsiteResult = { ok: true; data: { rawText: string } } | { ok: false; error: string };

/**
 * Fetches a business's own website and reduces it to plain text for n8n's
 * LLM to read. Deliberately simple — a regex strip, not an HTML parser:
 * the target is "readable text a human visiting the contact page would
 * see", not a faithful DOM, and n8n's own extraction step is what
 * actually has to make sense of it.
 *
 * Does NOT check robots.txt — a known simplification (same honesty
 * convention as google-places.ts's own caveats), acceptable for v1
 * because this crawls a business's OWN site once, identified by an
 * honest User-Agent, to find the SAME contact details a human visitor
 * would — not a bulk or repeated scrape.
 */
export async function crawlWebsite(url: string): Promise<CrawlWebsiteResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CRAWL_TIMEOUT_MS);
  try {
    // La URL viene del cliente (su propia web, en `suggest`) o de Google
    // Places (la de un prospecto): en ningún caso es nuestra.
    const res = await safeFetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `http_${res.status}` };
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType && !contentType.includes('text/html') && !contentType.includes('text/plain')) {
      return { ok: false, error: `unsupported_content_type:${contentType}` };
    }
    const html = await res.text();
    return { ok: true, data: { rawText: htmlToText(html) } };
  } catch (err) {
    if (err instanceof BlockedUrlError) return { ok: false, error: 'url_not_allowed' };
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return { ok: false, error: isAbort ? 'timeout' : err instanceof Error ? err.message : 'unknown_error' };
  } finally {
    clearTimeout(timer);
  }
}

function htmlToText(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const withoutTags = withoutScripts.replace(/<[^>]+>/g, ' ');
  const decoded = withoutTags
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  const collapsed = decoded.replace(/\s+/g, ' ').trim();
  return collapsed.slice(0, MAX_RAW_TEXT_CHARS);
}

// ---------------------------------------------------------------------------
// Extracción de contactos — pura, determinista y testeable sin red
// ---------------------------------------------------------------------------

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** Buzones que no son un contacto real del negocio. */
const EMAIL_BLOCKLIST = /^(no-?reply|noreply|postmaster|mailer-daemon|abuse|privacy|dpo|webmaster)@/i;
/** Dominios de ejemplo, plantillas sin rellenar y ficheros que parecen
 *  emails (`logo@2x.png`). */
const EMAIL_JUNK = /(@(example|test|localhost|dominio|tudominio|yourdomain)\.|@2x\.|\.(png|jpe?g|gif|svg|webp|css|js)$)/i;

/** Buzones genéricos de contacto, por orden de preferencia: si una web
 *  lista varios correos, el del negocio es casi siempre uno de estos y no
 *  el personal de un empleado. */
const PREFERRED_MAILBOXES = ['info', 'contacto', 'hola', 'citas', 'reservas', 'cita', 'contact', 'administracion'];

/**
 * Primer email de contacto útil del texto, o null.
 * Nunca devuelve algo que no esté literalmente en el texto.
 */
export function extractEmail(text: string): string | null {
  const found = (text.match(EMAIL_RE) ?? [])
    .map((raw) => raw.toLowerCase())
    .filter((email) => !EMAIL_BLOCKLIST.test(email) && !EMAIL_JUNK.test(email));
  if (found.length === 0) return null;

  const preferred = found.find((email) => PREFERRED_MAILBOXES.includes(email.split('@')[0]));
  return preferred ?? found[0];
}

/** Nueve dígitos españoles, con o sin prefijo +34/0034 y con los
 *  separadores habituales (espacios, puntos, guiones, paréntesis). */
const PHONE_RE = /(?:\+34|0034|34)?[\s.\-/]?([6-9])(?:[\s.\-/]?\d){8}/g;

/**
 * Primer teléfono español plausible del texto, normalizado a +34XXXXXXXXX,
 * o null.
 *
 * Solo móviles y fijos españoles (empiezan por 6, 7, 8 o 9 y tienen
 * exactamente nueve dígitos). Se descarta cualquier candidato que forme
 * parte de una cifra más larga —un NIF, un número de cuenta, un año
 * pegado a otra cosa— porque ahí casi nunca hay un teléfono.
 */
export function extractPhone(text: string): string | null {
  for (const match of text.matchAll(PHONE_RE)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const end = start + raw.length;

    // Pegado a más dígitos por cualquier lado: no es un teléfono suelto.
    if (/\d/.test(text[start - 1] ?? '') || /\d/.test(text[end] ?? '')) continue;

    const digits = raw.replace(/\D/g, '');
    const national = digits.length > 9 ? digits.slice(-9) : digits;
    if (national.length !== 9 || !/^[6-9]/.test(national)) continue;

    return `+34${national}`;
  }
  return null;
}

export interface ExtractedContact {
  contactEmail: string | null;
  contactPhone: string | null;
}

/** Lo que se saca de una web rastreada. Pura: mismo texto, misma salida. */
export function extractContactFromText(text: string): ExtractedContact {
  return { contactEmail: extractEmail(text), contactPhone: extractPhone(text) };
}

export interface EnrichmentSweepResult {
  processed: number;
  /** Leads a los que se les añadió al menos un dato de contacto. */
  enriched: number;
  crawlFailed: number;
  /** La web se rastreó bien, pero no había ni email ni teléfono. */
  noContactFound: number;
}

interface EnrichmentCandidate {
  id: string;
  clientId: string;
  website: string | null;
}

/**
 * The cron entry point (called from /api/cron/prospecting-tick). Coge hasta
 * ENRICHMENT_BATCH_SIZE leads outbound con web y sin intentar, rastrea cada
 * uno y le añade los contactos que encuentre. Todos los candidatos quedan
 * marcados con enrichmentRequestedAt al terminar, haya salido bien o no —
 * ver la cabecera del módulo para el porqué.
 */
export async function sweepPendingEnrichment(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<EnrichmentSweepResult> {
  const candidates = (await prisma.lead.findMany({
    where: { source: 'outbound', website: { not: null }, enrichmentRequestedAt: null },
    orderBy: { createdAt: 'asc' },
    take: ENRICHMENT_BATCH_SIZE,
    select: { id: true, clientId: true, website: true },
  })) as EnrichmentCandidate[];

  let enriched = 0;
  let crawlFailed = 0;
  let noContactFound = 0;

  for (const lead of candidates) {
    // website is guaranteed non-null by the query's `not: null` filter —
    // narrowed here only for TypeScript.
    const website = lead.website;
    if (!website) continue;

    const crawl = await crawlWebsite(website);
    if (!crawl.ok) {
      crawlFailed += 1;
      logError('prospecting_enrichment.crawl_failed', new Error(crawl.error), { leadId: lead.id }, 'warn');
    } else {
      const contact = extractContactFromText(crawl.data.rawText);
      if (contact.contactEmail || contact.contactPhone) {
        await applyLeadEnrichment(prisma, lead.id, contact, 'system:prospecting');
        enriched += 1;
      } else {
        noContactFound += 1;
      }
    }

    await prisma.lead.update({ where: { id: lead.id }, data: { enrichmentRequestedAt: now } });
  }

  return { processed: candidates.length, enriched, crawlFailed, noContactFound };
}
