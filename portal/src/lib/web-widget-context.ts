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
// Los textos en inglés y alemán existen porque las webs Signature van en varios
// idiomas (`data-lang="en"` → `?lang=en` en la petición de configuración; el
// alemán, desde el 15/11/2026, para hoteles). No son parte de lo que el negocio
// configura: son textos nuestros, como el aviso de IA.
// -----------------------------------------------------------------------------

/** Idiomas de la interfaz de embed.v2.js. El primero es el de siempre. */
export const WIDGET_LANGS = ['es', 'en', 'de'] as const;
export type WidgetLang = (typeof WIDGET_LANGS)[number];

/** El `?lang=` de la petición de configuración. Lo que no sea un idioma
 *  conocido (o falte) es español, igual que antes de que hubiera idiomas. */
export function parseWidgetLang(raw: string | null | undefined): WidgetLang {
  const code = String(raw ?? '')
    .trim()
    .toLowerCase()
    .split(/[-_]/)[0];
  return (WIDGET_LANGS as readonly string[]).includes(code) ? (code as WidgetLang) : 'es';
}

export const SENSITIVE_DATA_NOTICE: Record<WidgetLang, string> = {
  es: 'Por tu privacidad, no escribas aquí datos de salud. Para tu caso concreto, pide cita.',
  en: "For your privacy, please don't share health information here. For your specific case, book an appointment.",
  de: 'Zum Schutz Ihrer Privatsphäre teilen Sie hier bitte keine Gesundheitsdaten. Für Ihren konkreten Fall vereinbaren Sie bitte einen Termin.',
};

export function sensitiveDataNoticeFor(perfil: Record<string, unknown>, lang: string | null): string | null {
  if (perfil?.vertical !== 'clinica') return null;
  return SENSITIVE_DATA_NOTICE[parseWidgetLang(lang)];
}

// -----------------------------------------------------------------------------
// Saludo por defecto.
//
// Si el negocio no ha escrito su saludo en el paso 9, buildChatbotContext da
// «¡Hola! ¿En qué puedo ayudarte?». En una web en inglés o alemán ese saludo
// por defecto sale traducido. El saludo que SÍ escribió el negocio no se toca
// (puede estar ya en el idioma de su web): las webs que quieren otro saludo
// por idioma lo ponen con `KairikosChat.configure({ welcome })`.
// -----------------------------------------------------------------------------

export const DEFAULT_WELCOME: Record<WidgetLang, string> = {
  es: '¡Hola! ¿En qué puedo ayudarte?',
  en: 'Hi! How can I help you?',
  de: 'Hallo! Wie kann ich Ihnen helfen?',
};

export function welcomeMessageFor(welcome: string, lang: string | null): string {
  return welcome === DEFAULT_WELCOME.es ? DEFAULT_WELCOME[parseWidgetLang(lang)] : welcome;
}

// -----------------------------------------------------------------------------
// Aviso de privacidad y consentimiento del formulario de contacto (25/11/2026).
//
// Cuando el bot deriva, embed.v2.js pide nombre y teléfono o correo. Hasta esta
// fecha lo hacía sin decir quién trataba esos datos ni para qué, y sin casilla:
// los formularios de villas y de cartera sí la tenían (guardan `consentAt`). El
// contrato de encargo del tratamiento que firman los clientes Web Premium
// (plan-portal-encargo-tratamiento.md, PR 3) promete que el formulario informa
// y pide el consentimiento, así que ahora lo hace.
//
// El texto lo pinta el WIDGET, no esta ruta: embed.v2.js lleva los textos de
// cada idioma escritos dentro (no hay un viaje más al servidor para pedirlos) y
// manda con cada envío `noticeVersion`. Aquí queda escrito, para siempre, qué
// texto exacto corresponde a cada versión — mismo criterio que
// LEGAL_NOTICE_VERSION en recall-optout.ts: si dentro de un año alguien
// pregunta, la respuesta no es «qué dice hoy el widget» sino «qué leyó ESTA
// persona en diciembre», y eso solo se sabe con la versión guardada en la
// conversación. Un test compara estos textos con los de embed.v2.js: si
// cambias uno sin el otro, falla.
//
// Reglas:
//  - APPEND-ONLY. Una versión publicada no se edita ni se borra. Para cambiar
//    una palabra: versión nueva aquí, la constante del widget a esa versión, y
//    la vieja se queda en la tabla (los envíos de pestañas que siguen abiertas
//    con el script anterior la siguen mandando, y siguen siendo válidos).
//  - Una versión cubre los tres idiomas a la vez: el idioma lo elige la web
//    (data-lang), no la persona, y los tres textos se publican juntos.
//  - Redactado en primera persona o impersonal, para que valga igual en una web
//    que trata de tú o de usted (el widget va de tú en español y de Sie en
//    alemán, pero la web del cliente puede ir de usted).
//  - `{controller}` es el responsable del paso 10 (`responsable_tratamiento`),
//    o el nombre del negocio si ese paso no está aprobado.
//
// REDACCIÓN PENDIENTE DE REVISIÓN JURÍDICA, como el aviso de recall: es la
// primera capa (art. 13 RGPD por capas), y la segunda es la política de
// privacidad de la web, enlazada desde la casilla.
// -----------------------------------------------------------------------------

export interface WidgetContactNoticeTexts {
  /** Primera capa. `{controller}` se sustituye en el widget. */
  notice: string;
  /** La casilla, obligatoria. */
  consent: string;
  /** El texto del enlace a la política de privacidad. */
  privacyLink: string;
  /** El error si se envía sin marcar la casilla. */
  consentMissing: string;
}

/** La versión que pinta HOY embed.v2.js. */
export const WIDGET_CONTACT_NOTICE_VERSION = '2026-12-v1';

/** Todas las versiones publicadas. Append-only (ver arriba). */
export const WIDGET_CONTACT_NOTICES: Readonly<Record<string, Readonly<Record<WidgetLang, WidgetContactNoticeTexts>>>> = {
  '2026-12-v1': {
    es: {
      notice: 'Responsable: {controller}. Finalidad: responder a esta consulta.',
      consent: 'He leído la política de privacidad y acepto que se usen mis datos para responder a mi consulta.',
      privacyLink: 'Política de privacidad',
      consentMissing: 'Falta aceptar la política de privacidad.',
    },
    en: {
      notice: 'Controller: {controller}. Purpose: to answer this enquiry.',
      consent: 'I have read the privacy policy and agree to my details being used to answer my enquiry.',
      privacyLink: 'Privacy policy',
      consentMissing: 'Please accept the privacy policy.',
    },
    de: {
      notice: 'Verantwortlich: {controller}. Zweck: Beantwortung dieser Anfrage.',
      consent:
        'Ich habe die Datenschutzerklärung gelesen und bin mit der Verwendung meiner Daten zur Beantwortung meiner Anfrage einverstanden.',
      privacyLink: 'Datenschutzerklärung',
      consentMissing: 'Bitte akzeptieren Sie die Datenschutzerklärung.',
    },
  },
};

export function isKnownWidgetContactNoticeVersion(version: unknown): version is string {
  return typeof version === 'string' && Object.prototype.hasOwnProperty.call(WIDGET_CONTACT_NOTICES, version);
}

/** Lo que la configuración del widget devuelve como `privacy`. */
export interface WidgetPrivacyInfo {
  /** URL de la política de privacidad, solo http(s). */
  url: string | null;
  /** Responsable del tratamiento, tal como lo escribió el negocio. */
  controller: string | null;
}

/**
 * La política de privacidad y el responsable, sacados del paso 10 APROBADO
 * (`cumplimiento` de buildBotConfig: sin aprobar es `{}`, el paso no tiene
 * valor por defecto). null si no hay ninguno de los dos: el widget enseña
 * entonces el aviso sin enlace —salvo que la web le pase `data-privacy-url`,
 * que tiene prioridad— y el portal avisa al negocio en Canales.
 *
 * La URL se vuelve a comprobar aunque el esquema del paso 10 ya exija
 * `https://`: es lo que va a acabar en un href en la web de un tercero, y un
 * paso guardado antes de esa regla no la habría pasado.
 */
export function widgetPrivacyFromConfig(cumplimiento: Record<string, unknown> | null | undefined): WidgetPrivacyInfo | null {
  const rawUrl = typeof cumplimiento?.url_politica_privacidad === 'string' ? cumplimiento.url_politica_privacidad.trim() : '';
  const rawController =
    typeof cumplimiento?.responsable_tratamiento === 'string' ? cumplimiento.responsable_tratamiento.trim() : '';
  const url = safeHttpUrl(rawUrl);
  const controller = rawController ? rawController.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').slice(0, 120) : null;
  if (!url && !controller) return null;
  return { url, controller };
}

function safeHttpUrl(raw: string): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}
