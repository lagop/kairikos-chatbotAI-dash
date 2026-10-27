import 'server-only';
import { resolveActiveAnthropicCredentials } from './anthropic-credentials';
import { logError } from './observability';
import { SITE_LIMITS } from './site-content';
import { SITE_TEMPLATE_PARTS, type SiteTemplatePart, type SiteTemplateSource } from './site-template';
import { SITE_TEMPLATE_BASE } from './site-template-base';

// =============================================================================
// Webs con IA, entrega 2 (27/10/2026) — la IA DISEÑA una plantilla (marco +
// secciones, ver site-template.ts) para un sector. No escribe el contenido de
// ningún negocio: la misma plantilla sirve a todos los de su sector.
//
// Mismo molde que las demás integraciones de IA (lead-classification-ai.ts):
// fetch directo a la Messages API, sin SDK, NUNCA LANZA, degrada sin clave, y
// el parseo aislado en funciones puras para probarlo sin red. Tres cosas
// distintas, todas de las pruebas del 26/10:
//
// - STREAMING. Una plantilla son 25–35 mil tokens de salida y 2–3 minutos;
//   sin streaming la conexión queda muda todo ese rato.
// - ESFUERZO «medium». Con razonamiento adaptativo sin límite, Sonnet gastó
//   los 48.000 tokens pensando y no escribió nada (0,48 $ perdidos), y Haiku
//   cortó la plantilla a medias. Con esfuerzo medio: 157 s y 0,26 $.
// - La plantilla base va en el mensaje como EJEMPLO DE FORMATO. Explicar el
//   formato solo con palabras dejó, en la primera prueba, secciones sin
//   envolver y una sección duplicada; viendo una que cumple, se equivoca menos.
//
// El modelo por defecto es Sonnet y no el de la pantalla de ajustes (hoy
// Haiku): Haiku dejó rótulos ilegibles y textos tapados que Sonnet no. Una
// plantilla se diseña una vez y la usan muchas webs, así que el modelo caro
// se amortiza. ANTHROPIC_SITE_TEMPLATE_MODEL lo cambia en local.
// =============================================================================

const ANTHROPIC_VERSION = '2023-06-01';
export const DEFAULT_SITE_TEMPLATE_MODEL = 'claude-sonnet-5-5';
const MAX_OUTPUT_TOKENS = 64_000;
const REPAIR_MAX_TOKENS = 16_000;

/** $/millón de tokens (entrada, salida). Solo para apuntar lo que costó cada
 *  plantilla; si el modelo no está aquí, el coste queda sin calcular. */
const PRICES: Record<string, [number, number]> = {
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-sonnet-5-5': [2, 10],
  'claude-opus-5-5': [4, 20],
};

export function estimateCostUsd(model: string, usage: { input_tokens?: number; output_tokens?: number }): number | null {
  const p = PRICES[model];
  if (!p) return null;
  return Math.round((((usage.input_tokens ?? 0) * p[0] + (usage.output_tokens ?? 0) * p[1]) / 1e6) * 10000) / 10000;
}

export interface SiteTemplateBrief {
  /** Familia del sector ('trades', 'beauty'…) o texto libre. */
  sector: string;
  /** Qué tipo de negocio y qué carácter: «fontanería y reformas de baño;
   *  urgencias; confianza y limpieza». Lo escribe el operador. */
  encargo: string;
  /** Para que dos variantes del mismo sector no salgan iguales. */
  variante?: string | null;
}

// ---- Prompt ---------------------------------------------------------------------

function buildSystem(): string {
  return `Eres un diseñador web y desarrollador front-end excelente. Diseñas PLANTILLAS de web para pequeños negocios locales españoles: una plantilla sirve a todos los negocios de un sector, y el contenido de cada uno lo pone después el sistema. No escribes el contenido de ningún negocio.

DIRECCIÓN DE ARTE (lo más importante: tiene que verse como la web de una agencia buena, rica y con personalidad, NO sobria ni de plantilla):
- Empieza el <style> con un comentario que fije la dirección: paleta (un color de marca profundo + un acento vivo + neutros cálidos) como variables CSS en :root, pareja tipográfica de Google Fonts (una display con carácter + una sans muy legible) y un MOTIVO GRÁFICO propio del sector que repites en SVG decorativos (aria-hidden) por toda la página: fondos, separadores, esquinas.
- VARIEDAD DE COMPOSICIÓN: nada de «título + rejilla de tarjetas» en todas las secciones. Portada partida (texto a un lado, foto grande con formas decorativas y una tarjeta flotante con la valoración); banda a sangre con las cifras grandes; servicios en tarjetas con su icono y hover que las eleva; proceso como línea de tiempo numerada con contadores CSS; sección partida foto/texto; precios en tarjetas o tabla elegante; opiniones con la valoración grande; preguntas en acordeón (details/summary); zona con «chips»; banda final de llamada a sangre con el teléfono enorme.
- Profundidad: sombras suaves en capas, radios coherentes, fondos alternos, algún separador con forma (onda o diagonal).

ANIMACIONES: aparición al hacer scroll con IntersectionObserver, escalonada en las listas; hover que eleva tarjetas y mueve iconos; botón de llamar con un pulso sutil; decoración de portada flotando despacio. El contenido NUNCA depende de la animación para verse: lo que se oculta para animarlo solo se oculta si el JavaScript arrancó (html.js .clase), y el titular de la portada se ve al instante. Todo se apaga con prefers-reduced-motion.

ALINEACIÓN Y REPARTO (se mide con código en 360, 1100 y 1280 px):
- Un único contenedor (misma max-width, mismos márgenes laterales) para todas las secciones.
- Escala de espacios en :root y el mismo relleno vertical en todas las secciones.
- Las filas LLENAN el ancho: grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr)) — auto-FIT, nunca auto-fill. Con uno o dos elementos, que ocupen el ancho o vayan centrados, nunca arrinconados.
- Tarjetas de una fila con la misma altura y lo de abajo alineado al fondo (flex column + margin-top:auto).
- Párrafos de 60–75 caracteres por línea.
- Ningún texto tapado: si numeras con un círculo (::before), deja sitio de sobra para que no pise el título.

ROBUSTEZ: el dueño puede escribir hasta ${SITE_LIMITS.servicios} servicios, ${SITE_LIMITS.preciosFilas} precios, ${SITE_LIMITS.faq} preguntas, ${SITE_LIMITS.lugares} lugares, títulos de tres líneas, o poner solo uno de cada. Nada desborda de 360 a 1600 px: minmax(0,1fr), min-width:0, overflow-wrap:anywhere en los textos del cliente, nunca anchos fijos para contenido. Contraste AA en TODO el texto, también en los rótulos pequeños.

MENÚ: lo compone el sistema (como mucho cinco enlaces cortos). Va en una línea en escritorio con white-space:nowrap; por debajo de 1100 px, botón de menú desplegable. La cabecera es fija, se compacta y gana sombra al hacer scroll, y lleva el botón de llamar siempre visible.

FORMATO DE LA PLANTILLA — Mustache, y solo este subconjunto:
  {{campo}} texto escapado · {{{campo}}} HTML ya hecho (SOLO los campos *_html, secciones, citas_html, resenas_html, atribucion_google_html)
  {{#campo}}…{{/campo}} lista: repite; texto u objeto: muestra si tiene algo · {{^campo}}…{{/campo}} si está vacío · campos con punto
Lo decide el SISTEMA, no tú: qué secciones se pintan (no envuelvas una sección entera en {{#…}}: si está vacía u oculta, el sistema no la pinta), el menú, el envío del formulario, el año, la leyenda de datos de ejemplo y el noindex del borrador.

Las piezas, cada una precedida de su separador:
===MARCO===
  Documento completo: <html>, <head> con <title>{{pagina.meta_titulo}}</title> y <meta name="description" content="{{pagina.meta_descripcion}}">, el <style> entero, el sprite de iconos, la cabecera con <a href="{{pagina.inicio}}">{{nombre}}</a>, el menú EXACTAMENTE como {{#menu}}<a href="{{href}}"{{#actual}} aria-current="page"{{/actual}}>{{titulo}}</a>{{/menu}}, {{{secciones}}} UNA vez dentro de <main>, el pie con © {{anio}} {{nombre}}, y como mucho UN <script> al final del <body> solo para el aspecto (sin fetch, eval, cookies ni almacenamiento).
  El CSS da estilo a .dato-ejemplo (subrayado discontinuo + etiqueta «ejemplo» con ::after), .dato-ejemplo-bloque (un contorno discontinuo) y .leyenda-ejemplos (aviso fijo pequeño abajo a la izquierda): el sistema los usa para los datos de ejemplo.
===SECCION <nombre>===  una por cada una de: ${SITE_TEMPLATE_PARTS.join(', ')}
  Cada una es UN elemento (<section> normalmente) con id="{{ancla}}". Sin <script>, sin <html>/<head>/<body>.

CAMPOS (y ningún otro):
  Del negocio: {{nombre}} {{telefono}} {{telefono_href}} (en href="tel:{{telefono_href}}") {{direccion}} {{maps_url}} {{valoracion}} {{num_resenas}} {{horario_resumen}} — pueden venir vacíos: envuelve lo que dependa de ellos en {{#campo}}.
  Del contenido: {{titular}} {{subtitulo}} {{{sobre_html}}} {{llamada_accion}}
    {{#servicios}} {{nombre}} {{descripcion}} {{icono}} {{/servicios}} — el icono: <use href="#i-{{#icono}}{{icono}}{{/icono}}{{^icono}}check{{/icono}}">
    {{#cifras}} {{valor}} {{etiqueta}} {{/cifras}} · {{#proceso}} {{titulo}} {{texto}} {{/proceso}} · {{#garantias}} {{titulo}} {{texto}} {{/garantias}}
    {{#precios.filas}} {{concepto}} {{precio}} {{detalle}} {{/precios.filas}} y {{precios.nota}}
    {{zona.texto}} y {{#zona.lugares}} {{nombre}} {{/zona.lugares}} · {{#faq}} {{pregunta}} {{{respuesta_html}}} {{/faq}} · {{#horario}} {{dias}} {{horas}} {{/horario}}
  Opiniones (vienen de Google o del producto de reseñas): {{valoracion}} {{num_resenas}} {{maps_url}}, y en el borrador, ya escritos por el sistema (no cambies su HTML, dales estilo en tu CSS):
    {{{citas_html}}} = elementos <li class="cita"><h3>título</h3><p>«cita»</p><span class="cita-autor">autor · reseña de Google</span></li> para tu <ul class="citas">
    {{{resenas_html}}} = elementos <figure class="resena"><div class="resena-estrellas">★★★★★</div><blockquote><p>texto</p></blockquote><figcaption><strong>autor</strong> · hace un año · reseña de Google</figcaption></figure> para tu contenedor (rejilla de tarjetas)
    {{{atribucion_google_html}}} = <p class="atribucion-google">aviso + logotipo de Google Maps</p>, justo debajo de las reseñas
  El CSS del marco tiene que dar estilo a .cita, .cita-autor, .resena, .resena-estrellas y .atribucion-google, y envolver cada bloque en {{#citas_html}}…{{/citas_html}} / {{#resenas_html}}…{{/resenas_html}} (pueden venir vacíos).
  Fotos: {{fotos.portada}} {{fotos.equipo}} {{fotos.trabajo}} — pueden venir vacías: envuélvelas en {{#fotos.portada}}.
  Bloques libres (secciones bloque_*): {{titulo}} {{{texto_html}}} {{foto}} {{fotoAlt}} y {{#items}} {{texto}} {{icono}} {{/items}}.
  Formulario (sección contacto): <form id="kairikos-form"> con campos name="name", name="contact" (teléfono o email) y name="message", con sus <label>; el botón con {{#formulario.muestra}} disabled{{/formulario.muestra}}; un <p id="kairikos-form-note" hidden></p>; y {{#formulario.muestra}}<p>Formulario de muestra: en la web publicada, los mensajes le llegan al correo.</p>{{/formulario.muestra}}. Sin action ni onsubmit: el envío lo pone el sistema.
  Iconos: un sprite al principio del <body> (<svg aria-hidden="true" style="display:none">) con 10–14 <symbol id="i-…"> dibujados por ti con trazo coherente, propios del sector, e incluye siempre i-check, i-telefono e i-estrella.

PROHIBIDO: escribir cifras en la plantilla (todo número sale del contenido; numera con contadores CSS), recursos externos que no sean Google Fonts, iframes, atributos on*, enlaces javascript:.

Español de España; al visitante se le habla de usted. Los rótulos fijos («Servicios», «Preguntas frecuentes», «Llamar») los escribes tú.

Devuelve SOLO las piezas con sus separadores, sin explicaciones ni vallas de markdown.`;
}

function serializeTemplate(t: SiteTemplateSource): string {
  return [`===MARCO===`, t.marco, ...SITE_TEMPLATE_PARTS.map((p) => `===SECCION ${p}===\n${t.secciones[p] ?? ''}`)].join('\n');
}

function buildUser(brief: SiteTemplateBrief): string {
  return [
    `Sector: ${brief.sector}`,
    `Encargo: ${brief.encargo}`,
    brief.variante ? `Variante: ${brief.variante} (que no se parezca a otras plantillas del mismo sector)` : null,
    '',
    'EJEMPLO DEL FORMATO — una plantilla que cumple todas las reglas técnicas. NO copies su diseño (es sobria a propósito); copia cómo usa los campos, el menú, el formulario y los separadores:',
    serializeTemplate(SITE_TEMPLATE_BASE),
  ]
    .filter((l) => l !== null)
    .join('\n');
}

// ---- Parseo (puro) ---------------------------------------------------------------

function stripCodeFence(text: string): string {
  return text.trim().replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '');
}

/**
 * Convierte la respuesta en las piezas de una plantilla, o null si no hay
 * marco. Las piezas que falten quedan sin poner: las detecta el validador y
 * las pide la ronda de corrección, que es más barato que repetirlo todo.
 */
export function parseTemplateResponse(text: string): SiteTemplateSource | null {
  const clean = stripCodeFence(text);
  const re = /^===(MARCO|SECCION ([a-z_]+))===[ \t]*$/gm;
  const marks: { name: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) marks.push({ name: m[2] ?? 'marco', start: m.index, end: re.lastIndex });
  if (!marks.length) return null;
  const parts: Record<string, string> = {};
  marks.forEach((mark, i) => {
    const body = clean.slice(mark.end, i + 1 < marks.length ? marks[i + 1].start : clean.length).trim();
    parts[mark.name] = stripCodeFence(body);
  });
  if (!parts.marco) return null;
  const secciones: Partial<Record<SiteTemplatePart, string>> = {};
  for (const [name, body] of Object.entries(parts)) {
    if (name !== 'marco' && body) secciones[name as SiteTemplatePart] = body;
  }
  return { marco: parts.marco, secciones };
}

export interface TemplateEdit {
  pieza: 'marco' | SiteTemplatePart;
  buscar: string;
  reemplazar: string;
}

/** Interpreta la respuesta de una ronda de corrección. */
export function parseRepairResponse(text: string): { diagnostico: string; cambios: TemplateEdit[] } | null {
  try {
    const raw = JSON.parse(stripCodeFence(text)) as { diagnostico?: unknown; cambios?: unknown };
    if (!Array.isArray(raw.cambios)) return null;
    const cambios = raw.cambios
      .filter((c): c is TemplateEdit => {
        const e = c as Partial<TemplateEdit>;
        return typeof e.pieza === 'string' && typeof e.buscar === 'string' && typeof e.reemplazar === 'string' && e.buscar.length > 0;
      })
      .slice(0, 40);
    return { diagnostico: typeof raw.diagnostico === 'string' ? raw.diagnostico.slice(0, 1000) : '', cambios };
  } catch {
    return null;
  }
}

/**
 * Aplica cambios buscar/reemplazar. Un «buscar» que no aparece exactamente
 * una vez en su pieza no se aplica (y se informa): reemplazar a ciegas la
 * primera de varias coincidencias rompería otra parte del diseño. Añadir una
 * pieza que faltaba se hace con buscar «(vacía)».
 */
export function applyTemplateEdits(
  template: SiteTemplateSource,
  edits: TemplateEdit[],
): { template: SiteTemplateSource; applied: number; failed: string[] } {
  const next: SiteTemplateSource = { marco: template.marco, secciones: { ...template.secciones } };
  const failed: string[] = [];
  let applied = 0;
  for (const edit of edits) {
    const isMarco = edit.pieza === 'marco';
    if (!isMarco && !(SITE_TEMPLATE_PARTS as readonly string[]).includes(edit.pieza)) {
      failed.push(`pieza desconocida «${edit.pieza}»`);
      continue;
    }
    const current = isMarco ? next.marco : (next.secciones[edit.pieza as SiteTemplatePart] ?? '');
    if (edit.buscar === '(vacía)' && !current.trim()) {
      if (isMarco) next.marco = edit.reemplazar;
      else next.secciones[edit.pieza as SiteTemplatePart] = edit.reemplazar;
      applied++;
      continue;
    }
    const count = current.split(edit.buscar).length - 1;
    if (count !== 1) {
      failed.push(`«${edit.buscar.slice(0, 60)}» aparece ${count} veces en ${edit.pieza}`);
      continue;
    }
    const updated = current.replace(edit.buscar, () => edit.reemplazar);
    if (isMarco) next.marco = updated;
    else next.secciones[edit.pieza as SiteTemplatePart] = updated;
    applied++;
  }
  return { template: next, applied, failed };
}

// ---- Llamadas -----------------------------------------------------------------

export type TemplateAiUsage = { input_tokens?: number; output_tokens?: number };

export type GenerateSiteTemplateResult =
  | { ok: true; template: SiteTemplateSource; model: string; usage: TemplateAiUsage; costUsd: number | null; seconds: number }
  | { ok: true; skipped: true; reason: 'no_api_key' }
  | { ok: false; error: string; model?: string; usage?: TemplateAiUsage; costUsd?: number | null };

/** Una llamada en streaming; devuelve el texto y el uso. Nunca lanza. */
async function streamMessage(body: object): Promise<
  { ok: true; text: string; usage: TemplateAiUsage; stop: string | null } | { ok: false; error: string; usage?: TemplateAiUsage }
> {
  const resolved = await resolveActiveAnthropicCredentials();
  if (!resolved) return { ok: false, error: 'no_api_key' };
  try {
    const res = await fetch(`${resolved.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': resolved.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      body: JSON.stringify({ ...body, stream: true }),
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      return { ok: false, error: `anthropic_api_error:${res.status}:${detail.slice(0, 300)}` };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let usage: TemplateAiUsage = {};
    let stop: string | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        let ev: { type?: string; delta?: { type?: string; text?: string; stop_reason?: string }; usage?: TemplateAiUsage; message?: { usage?: TemplateAiUsage }; error?: { message?: string } };
        try {
          ev = JSON.parse(line.slice(5));
        } catch {
          continue;
        }
        if (ev.type === 'message_start') usage = { ...usage, ...ev.message?.usage };
        else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') text += ev.delta.text ?? '';
        else if (ev.type === 'message_delta') {
          usage = { ...usage, ...ev.usage };
          stop = ev.delta?.stop_reason ?? null;
        } else if (ev.type === 'error') return { ok: false, error: `anthropic_stream_error:${ev.error?.message ?? ''}`, usage };
      }
    }
    return { ok: true, text, usage, stop };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}

function modelFor(override?: string | null): string {
  // `||` y no `??`: una variable declarada y vacía cuenta como ausente
  // (trampa nº 4 de CLAUDE.md).
  return override || process.env.ANTHROPIC_SITE_TEMPLATE_MODEL || DEFAULT_SITE_TEMPLATE_MODEL;
}

export async function generateSiteTemplate(brief: SiteTemplateBrief, options: { model?: string | null } = {}): Promise<GenerateSiteTemplateResult> {
  const model = modelFor(options.model);
  const t0 = Date.now();
  const r = await streamMessage({
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    system: buildSystem(),
    messages: [{ role: 'user', content: buildUser(brief) }],
  });
  if (!r.ok) {
    if (r.error === 'no_api_key') return { ok: true, skipped: true, reason: 'no_api_key' };
    logError('site_template_ai.generate', new Error(r.error), { route: 'lib/site-template-ai.ts' }, 'warn');
    return { ok: false, error: r.error, model, usage: r.usage, costUsd: r.usage ? estimateCostUsd(model, r.usage) : null };
  }
  const costUsd = estimateCostUsd(model, r.usage);
  if (r.stop === 'max_tokens') return { ok: false, error: 'max_tokens', model, usage: r.usage, costUsd };
  const template = parseTemplateResponse(r.text);
  if (!template) return { ok: false, error: 'unparseable_template', model, usage: r.usage, costUsd };
  return { ok: true, template, model, usage: r.usage, costUsd, seconds: Math.round((Date.now() - t0) / 1000) };
}

export type RepairSiteTemplateResult =
  | { ok: true; template: SiteTemplateSource; diagnostico: string; applied: number; failed: string[]; model: string; usage: TemplateAiUsage; costUsd: number | null }
  | { ok: false; error: string; usage?: TemplateAiUsage; costUsd?: number | null };

/**
 * Una ronda de corrección: la plantilla y la lista de fallos (del validador o
 * de las comprobaciones en el navegador), y el modelo devuelve cambios
 * buscar/reemplazar por pieza. Los fallos tienen que traer las reglas CSS que
 * aplican: en la prueba del 26/10, con solo las medidas el modelo adivinó dos
 * rondas seguidas; con las reglas acertó a la primera.
 */
export async function repairSiteTemplate(
  template: SiteTemplateSource,
  problems: string[],
  options: { model?: string | null } = {},
): Promise<RepairSiteTemplateResult> {
  const model = modelFor(options.model);
  const system = `Eres el desarrollador front-end que hizo esta plantilla Mustache. Unas comprobaciones automáticas han encontrado fallos. Corrígelos con el MENOR cambio posible, sin tocar el diseño ni los rótulos, y sin introducir fallos nuevos (de 360 a 1600 px). Respeta las reglas del formato: los campos, el menú {{#menu}}, {{{secciones}}}, id="{{ancla}}" en cada sección, el formulario con sus ids y nombres, nada de cifras escritas, nada de on*.

Devuelves SOLO un JSON, sin vallas de markdown:
{"diagnostico": "la causa de cada fallo, en una o dos frases", "cambios": [{"pieza": "marco" o el nombre de la sección, "buscar": "texto EXACTO de esa pieza, que aparezca UNA sola vez", "reemplazar": "texto nuevo"}]}
Para CSS nuevo: pieza "marco", buscar "</style>", reemplazar "TU CSS\\n</style>". Para escribir una sección que falta: buscar "(vacía)".`;
  const user = `FALLOS:\n${problems.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n\nPLANTILLA:\n${serializeTemplate(template)}`;
  const r = await streamMessage({
    model,
    max_tokens: REPAIR_MAX_TOKENS,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    system,
    messages: [{ role: 'user', content: user }],
  });
  if (!r.ok) return { ok: false, error: r.error, usage: r.usage, costUsd: r.usage ? estimateCostUsd(model, r.usage) : null };
  const costUsd = estimateCostUsd(model, r.usage);
  const parsed = parseRepairResponse(r.text);
  if (!parsed) return { ok: false, error: 'unparseable_repair', usage: r.usage, costUsd };
  const result = applyTemplateEdits(template, parsed.cambios);
  return { ok: true, template: result.template, diagnostico: parsed.diagnostico, applied: result.applied, failed: result.failed, model, usage: r.usage, costUsd };
}
