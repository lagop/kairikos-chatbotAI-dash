import { randomBytes } from 'node:crypto';

// =============================================================================
// Informe mensual de resultados (28/11/2026) — las reglas puras del contrato
// de eventos de la web Premium, sin base de datos: qué acepta la ruta pública
// /api/public/web-events/[token] y cómo se reconoce un token.
//
// El contrato completo, para que las webs Astro lo cumplan, está en
// docs/informe-mensual-web.md. Si cambias algo aquí, cámbialo allí.
// =============================================================================

/** Lo que la web puede contar. Cerrado a propósito: un tipo nuevo es una
 *  decisión de producto (aparece en el informe), no algo que mande la web. */
export const WEB_EVENT_KINDS = [
  'landing',
  'call_click',
  'whatsapp_click',
  'email_click',
  'form_submit',
  'booking_submit',
  'chat_start',
] as const;
export type WebEventKind = (typeof WEB_EVENT_KINDS)[number];

/** De dónde llegó la visita. Solo tiene sentido en 'landing'; la web lo
 *  decide con document.referrer (ver la doc): 'ai' son ChatGPT, Perplexity,
 *  Claude, Gemini y Copilot. */
export const WEB_EVENT_SOURCES = ['ai', 'search', 'social', 'other', 'direct'] as const;
export type WebEventSource = (typeof WEB_EVENT_SOURCES)[number];

/** Un evento real ocupa unos 30 bytes. 512 deja margen y corta cualquier
 *  intento de usar la ruta para subir otra cosa. */
export const MAX_WEB_EVENT_BYTES = 512;

/** Eventos por minuto para una misma IP y token. Una visita normal manda
 *  dos o tres; sesenta solo los alcanza un bucle o alguien inflando cifras. */
export const WEB_EVENTS_PER_MINUTE = 60;

/** El reloj del informe: el día y el mes del cliente, no los de UTC. */
export const WEB_RESULTS_TIMEZONE = 'Atlantic/Canary';

const EVENTS_TOKEN_RE = /^wev_[A-Za-z0-9_-]{32}$/;

/** wev_ + 32 caracteres url-safe (24 bytes, 192 bits). No es un secreto —va
 *  en el HTML de la web—, pero no se puede adivinar el de otro cliente. */
export function generateEventsToken(): string {
  return `wev_${randomBytes(24).toString('base64url')}`;
}

export function isEventsTokenShape(token: string): boolean {
  return EVENTS_TOKEN_RE.test(token);
}

export interface ParsedWebEvent {
  kind: WebEventKind;
  /** '' cuando no aplica: la columna es NOT NULL y forma parte del índice único. */
  source: WebEventSource | '';
}

/**
 * Del cuerpo crudo al evento, o null si no vale. `{"k":"landing","s":"ai"}`.
 *
 * El origen solo se guarda en 'landing'; en el resto se fuerza '' aunque la
 * web lo mande, para que un clic en WhatsApp no se reparta en cinco filas.
 * Un 'landing' con un origen desconocido o ausente cuenta como 'other': la
 * visita existió, y perderla por una etiqueta mal escrita falsearía el total.
 */
export function parseWebEvent(raw: string): ParsedWebEvent | null {
  if (!raw || raw.length > MAX_WEB_EVENT_BYTES) return null;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { k, s } = body as { k?: unknown; s?: unknown };
  if (typeof k !== 'string' || !(WEB_EVENT_KINDS as readonly string[]).includes(k)) return null;
  const kind = k as WebEventKind;
  if (kind !== 'landing') return { kind, source: '' };
  const source =
    typeof s === 'string' && (WEB_EVENT_SOURCES as readonly string[]).includes(s) ? (s as WebEventSource) : 'other';
  return { kind, source };
}

/** text/plain es lo que manda sendBeacon con una cadena (sin preflight);
 *  application/json, lo que manda un fetch normal. Sin cabecera también vale. */
export function isAcceptedContentType(contentType: string | null): boolean {
  if (!contentType) return true;
  const base = contentType.split(';')[0].trim().toLowerCase();
  return base === 'text/plain' || base === 'application/json';
}

const BOT_UA_RE = /bot|crawler|spider|headless/i;

/** Los rastreadores que ejecutan JavaScript también disparan el beacon. No
 *  es una defensa (el UA se falsifica), solo quita el ruido evidente. */
export function isBotUserAgent(userAgent: string | null): boolean {
  if (!userAgent) return false;
  return BOT_UA_RE.test(userAgent);
}

function hostOf(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * ¿Viene el evento de la web del cliente? `originOrReferer` es la cabecera
 * Origin (la manda siempre el navegador en un POST de sendBeacon) o, si
 * falta, el Referer.
 *
 * Vale el mismo host o un subdominio, con o sin www: la web puede servirse
 * en clinica.es y en www.clinica.es, o tener una versión en en.clinica.es.
 * No es seguridad —una cabecera se falsifica con curl—; es lo que evita que
 * alguien copie el snippet en otra web y le infle las cifras sin querer.
 */
export function originMatchesSite(originOrReferer: string | null, siteUrl: string): boolean {
  if (!originOrReferer) return false;
  const siteHost = hostOf(siteUrl);
  const host = hostOf(originOrReferer);
  if (!siteHost || !host) return false;
  return host === siteHost || host.endsWith(`.${siteHost}`);
}
