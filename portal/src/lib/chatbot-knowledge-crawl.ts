import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { ingestKnowledgeDocument } from './chatbot-knowledge';
import { logError } from './observability';
import { safeFetch, BlockedUrlError } from './safe-fetch';

// =============================================================================
// Fase 3 — rastreo de la propia web del cliente para la base de conocimiento.
//
// Por qué no se reutiliza `crawlWebsite` de prospecting-enrichment.ts, que
// hace algo parecido: aquel colapsa TODOS los espacios en blanco a uno
// solo, porque lo único que busca son un email y un teléfono con una
// expresión regular. Aquí la estructura en párrafos es el dato — es por
// donde se trocea el documento (ver chunkText). Reutilizarlo daría un
// único bloque de 20.000 caracteres sin un solo corte natural. Son dos
// rastreadores porque son dos trabajos, no por descuido.
//
// Rastrea UNA página, la que el cliente indique, no el sitio entero. Un
// rastreador que sigue enlaces necesita presupuesto, detección de bucles,
// y decidir qué es "el mismo sitio" — y el material que de verdad sirve
// para un bot de pyme (servicios, precios, quiénes somos, cómo llegar)
// vive en una o dos páginas que el cliente sabe señalar. Es una limitación
// conocida y aceptada, no un descuido: el cliente añade tantas URLs como
// páginas quiera indexar.
// =============================================================================

const CRAWL_TIMEOUT_MS = 10_000;
const MAX_HTML_BYTES = 2_000_000;
/** Techo por tick del cron. Acota cuántas peticiones a terceros puede
 *  bloquear una sola invocación — misma razón que ENRICHMENT_BATCH_SIZE. */
export const CRAWL_BATCH_SIZE = 5;

const USER_AGENT = 'Mozilla/5.0 (compatible; KairikosKnowledgeBot/1.0; +https://kairikos.com)';

export type FetchPageResult =
  | { ok: true; data: { title: string | null; text: string } }
  | { ok: false; error: string };

/**
 * Solo http(s) y solo host público. Sin esto, un cliente podría pedirnos
 * que rastreáramos `http://localhost:5432` o una IP interna y usar nuestro
 * servidor como sonda de su red — el fallo clásico de cualquier función
 * que descarga una URL que manda el usuario (SSRF).
 *
 * Esto es solo el filtro rápido para dar un error claro al guardar: mira el
 * nombre, no la IP. La barrera de verdad es safe-fetch.ts, que comprueba la
 * IP al conectar y en cada redirección. Hasta el 22/09/2026 este filtro era
 * la única defensa y la descarga seguía redirecciones: un 302 hacia
 * `http://n8n:5678` metía páginas internas en la base de conocimiento, que el
 * cliente podía leer preguntándole a su propio bot.
 */
export function isCrawlableUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return false;
  if (host === '0.0.0.0' || host === '::1' || host === '[::1]') return false;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  // Un host sin punto no es un dominio público ('metadata', 'db', un
  // nombre de servicio de Docker Compose).
  if (!host.includes('.')) return false;

  return true;
}

/**
 * Descarga una página y la reduce a texto con sus párrafos intactos.
 *
 * Una tira de expresiones regulares, no un analizador de HTML: el objetivo
 * es "lo que leería una persona que abre la página", y añadir una
 * dependencia de parseo para eso no se paga. Lo que sí se cuida es
 * convertir los cierres de bloque en saltos de línea ANTES de quitar las
 * etiquetas, que es lo que preserva la separación entre párrafos.
 */
export async function fetchPageAsText(url: string): Promise<FetchPageResult> {
  if (!isCrawlableUrl(url)) {
    return { ok: false, error: 'url_not_allowed' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CRAWL_TIMEOUT_MS);
  try {
    const res = await safeFetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      signal: controller.signal,
      maxBytes: MAX_HTML_BYTES,
    });
    if (!res.ok) return { ok: false, error: `http_${res.status}` };

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType && !contentType.includes('text/html') && !contentType.includes('text/plain')) {
      return { ok: false, error: `unsupported_content_type:${contentType.split(';')[0]}` };
    }

    const html = (await res.text()).slice(0, MAX_HTML_BYTES);
    const text = htmlToParagraphs(html);
    if (text.trim().length === 0) {
      // Casi siempre una web que se pinta entera con JavaScript: el HTML
      // que llega no tiene texto. Se dice como es, en vez de guardar un
      // documento vacío que el bot no podría usar.
      return { ok: false, error: 'no_readable_text' };
    }
    return { ok: true, data: { title: extractTitle(html), text } };
  } catch (err) {
    if (err instanceof BlockedUrlError) return { ok: false, error: 'url_not_allowed' };
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return { ok: false, error: isAbort ? 'timeout' : err instanceof Error ? err.message : 'unknown_error' };
  } finally {
    clearTimeout(timer);
  }
}

/** Bloques cuyo cierre marca un salto de párrafo real. */
const BLOCK_END =
  /<\/(p|div|section|article|header|footer|main|aside|li|ul|ol|h[1-6]|table|tr|blockquote|figcaption)\s*>/gi;

export function htmlToParagraphs(html: string): string {
  const stripped = html
    // El <head> primero: su <title> es texto de verdad y si no se quita
    // acaba pegado al principio del primer párrafo, duplicando el título
    // del documento dentro de su propio contenido. `extractTitle` lee el
    // HTML original, así que sigue encontrándolo. El <title> suelto es el
    // respaldo para las páginas que no cierran el <head>.
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<title[\s\S]*?<\/title>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // La navegación y el pie se repiten en cada página y son ruido puro
    // dentro de un fragmento recuperado.
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ');

  const withBreaks = stripped
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(BLOCK_END, '\n\n');

  const text = decodeEntities(withBreaks.replace(/<[^>]+>/g, ' '));

  return text
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

export function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return null;
  const title = decodeEntities(match[1]).replace(/\s+/g, ' ').trim();
  return title.length > 0 ? title.slice(0, 200) : null;
}

// ---------------------------------------------------------------------------
// El barrido del cron
// ---------------------------------------------------------------------------

export interface CrawlSweepResult {
  processed: number;
  ingested: number;
  failed: number;
}

/**
 * Rastrea los documentos 'web' que quedaron encolados.
 *
 * El rastreo no ocurre cuando el cliente pulsa Guardar: descargar una web
 * ajena puede tardar diez segundos y puede fallar, y bloquear el formulario
 * del cliente en eso haría que un sitio lento pareciera un portal roto. Se
 * encola en 'pending' y este barrido lo resuelve.
 *
 * Un documento que falla queda en 'failed' con su motivo y **no se
 * reintenta solo** — misma postura que el enriquecimiento de prospección:
 * una web caída o que se pinta con JavaScript es un hecho estable, no algo
 * transitorio, y reintentarlo cada cinco minutos para siempre solo gasta
 * peticiones. El cliente lo ve marcado y decide si lo reintenta.
 */
export async function sweepPendingKnowledgeCrawls(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<CrawlSweepResult> {
  const pending = await prisma.chatbotKnowledgeDocument.findMany({
    where: { status: 'pending', source: 'web', sourceUrl: { not: null } },
    orderBy: { createdAt: 'asc' },
    take: CRAWL_BATCH_SIZE,
    select: { id: true, clientId: true, clientProductId: true, tenantId: true, title: true, sourceUrl: true },
  });

  let ingested = 0;
  let failed = 0;

  for (const doc of pending) {
    const url = doc.sourceUrl!;
    const page = await fetchPageAsText(url);

    if (!page.ok) {
      failed += 1;
      await markFailed(prisma, doc, page.error, now);
      continue;
    }

    const result = await ingestKnowledgeDocument(prisma, {
      clientId: doc.clientId,
      // Fase 4 multi-instancia — el documento pendiente ya sabe de qué chatbot
      // es (lo creó la ruta de ese chatbot); sus fragmentos lo heredan.
      clientProductId: doc.clientProductId,
      tenantId: doc.tenantId,
      source: 'web',
      // El <title> de la página es mejor etiqueta que la URL para que el
      // cliente reconozca lo que indexó; si no lo hay, se conserva la que
      // ya tenía la fila.
      title: page.data.title ?? doc.title,
      content: page.data.text,
      documentId: doc.id,
      actorId: 'system:knowledge',
      now,
    });

    if (result.ok) {
      ingested += 1;
    } else {
      failed += 1;
      await markFailed(prisma, doc, result.error, now);
    }
  }

  return { processed: pending.length, ingested, failed };
}

async function markFailed(
  prisma: PrismaClient,
  doc: { id: string; clientId: string; tenantId: string | null; sourceUrl: string | null },
  error: string,
  now: Date,
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.chatbotKnowledgeDocument.update({
        where: { id: doc.id },
        data: { status: 'failed', error: error.slice(0, 300), crawledAt: now },
      });
      await tx.chatbotKnowledgeDocumentAudit.create({
        data: {
          documentId: doc.id,
          clientId: doc.clientId,
          tenantId: doc.tenantId,
          action: 'crawl_failed',
          after: { url: doc.sourceUrl, error: error.slice(0, 300) },
          actorId: 'system:knowledge',
        },
      });
    });
  } catch (err) {
    logError('chatbot_knowledge_crawl.mark_failed', err, { documentId: doc.id }, 'warn');
  }
}
