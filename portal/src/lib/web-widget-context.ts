import 'server-only';

// =============================================================================
// Widget v2 — el `context` opcional que manda embed.v2.js con cada mensaje.
//
// La web del cliente le dice al widget en qué página o tratamiento está el
// visitante (`KairikosChat.setContext({ page, topic, lang })`), y el widget lo
// adjunta a cada POST a /api/public/channels/web/message. Aquí se valida y se
// convierte en UNA línea breve que el motor pone en el prompt, por ejemplo:
//
//   El visitante está en la página «/tratamientos/implantes» (tema: implantes).
//
// Tres decisiones, por orden de importancia:
//
//  1. Un `context` inválido se IGNORA, no devuelve 400. El campo es un extra:
//     una web que manda una clave de más no puede dejar al visitante sin
//     respuesta. Por eso parseVisitorContext devuelve null y no lanza.
//  2. No se guarda en ningún sitio: ni en el transcript ni como contenido del
//     mensaje. Es orientación para ESTE turno, no algo que dijo la persona.
//  3. Lo escribe quien controla la página —o cualquiera con curl—, igual que el
//     propio mensaje. No da más poder que el mensaje, pero se trata igual: el
//     prompt lo presenta como dato de la visita, no como instrucciones, y aquí
//     se quitan saltos de línea y caracteres de control para que no pueda
//     fingir una sección nueva del prompt.
//
// Límites del contrato (docs/widget-v2.md): como mucho 5 claves, valores de
// hasta 120 caracteres. embed.v2.js ya los recorta antes de enviar; esto es la
// segunda capa, porque la ruta es pública.
// =============================================================================

export const VISITOR_CONTEXT_MAX_KEYS = 5;
export const VISITOR_CONTEXT_MAX_VALUE = 120;
const KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

export type VisitorContext = Record<string, string>;

/** Saltos de línea, tabuladores y cualquier carácter de control pasan a ser
 *  un espacio; los espacios repetidos se colapsan. */
// Construida desde texto para que en el fuente solo haya escapes ASCII: el
// U+2028 literal dentro de una regex es un fin de línea para el parser.
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+', 'g');

function cleanValue(value: string): string {
  return value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * El `context` del cuerpo, validado, o null si falta o no cumple el contrato.
 * Todo o nada: con una sola clave mal formada se descarta entero, para no
 * mandar al modelo medio contexto que la web no quiso decir así.
 */
export function parseVisitorContext(raw: unknown): VisitorContext | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;

  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0 || entries.length > VISITOR_CONTEXT_MAX_KEYS) return null;

  const out: VisitorContext = {};
  for (const [key, value] of entries) {
    if (!KEY_RE.test(key)) return null;
    if (typeof value !== 'string') return null;
    if (value.length > VISITOR_CONTEXT_MAX_VALUE) return null;
    const cleaned = cleanValue(value);
    if (cleaned) out[key] = cleaned;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * La línea que lee el modelo. `page`, `topic` y `lang` tienen frase propia
 * porque son las que usa la web Signature; cualquier otra clave va al final
 * como `clave: valor`, sin interpretarla.
 */
export function buildVisitorContextLine(context: VisitorContext | null): string | null {
  if (!context) return null;
  const { page, topic, lang, ...rest } = context;

  const parts: string[] = [];
  if (page) parts.push(`El visitante está en la página «${page}»`);
  else parts.push('El visitante está en la web del negocio');

  const details: string[] = [];
  if (topic) details.push(`tema: ${topic}`);
  if (lang) details.push(`idioma de la página: ${lang}`);
  for (const [key, value] of Object.entries(rest)) details.push(`${key}: ${value}`);

  if (details.length > 0) parts.push(` (${details.join('; ')})`);
  return `${parts.join('')}.`;
}

// -----------------------------------------------------------------------------
// Aviso de datos sensibles (config del widget, campo `sensitiveDataNotice`).
//
// En una clínica, el chat es justo donde alguien escribe «tengo un flemón y soy
// diabético»: un dato de salud (art. 9 RGPD) que acaba en el transcript, en el
// proveedor de IA y en el correo de traspaso. No se puede impedir, pero sí
// pedir que no se haga. Sale cuando el paso 1 del chatbot dice `vertical:
// 'clinica'`; para el resto de sectores es null y v2 no pinta nada. v1 ignora
// el campo.
//
// El texto en inglés existe porque las webs Signature van en inglés
// (`data-lang="en"` → `?lang=en` en la petición de configuración). No es parte
// de lo que el negocio configura: es un texto nuestro, como el aviso de IA.
// -----------------------------------------------------------------------------

export const SENSITIVE_DATA_NOTICE = {
  es: 'Por tu privacidad, no escribas aquí datos de salud. Para tu caso concreto, pide cita.',
  en: "For your privacy, please don't share health information here. For your specific case, book an appointment.",
} as const;

export function sensitiveDataNoticeFor(perfil: Record<string, unknown>, lang: string | null): string | null {
  if (perfil?.vertical !== 'clinica') return null;
  return lang === 'en' ? SENSITIVE_DATA_NOTICE.en : SENSITIVE_DATA_NOTICE.es;
}
