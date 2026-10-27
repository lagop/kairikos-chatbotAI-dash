import { SITE_SECTION_TYPES } from './site-content';
import { declaredFontFamilies, fontCatalogForPrompt } from './site-fonts';
import { validateTemplateStyle } from './site-style';
import {
  SITE_TEMPLATE_PARTS,
  TemplateSyntaxError,
  collectTags,
  parseMustache,
  type SiteTemplatePart,
  type SiteTemplateSource,
} from './site-template';

// =============================================================================
// Webs con IA, entrega 1 (27/10/2026) — lo que una plantilla tiene que cumplir
// antes de pintar la web de nadie.
//
// Comprueba lo que se ve leyendo la plantilla, sin navegador. Lo que solo se
// ve pintando (desbordes, contraste, reparto, solapes) va aparte, en las
// comprobaciones con navegador de la entrega 2.
//
// Los mensajes están escritos para el modelo que la corrige, no para un
// humano: dicen QUÉ pieza, QUÉ falla y CÓMO se arregla. En la prueba del
// 26/10, la ronda que recibió «la regla CSS que aplica» acertó a la primera;
// las que solo recibieron «esto se sale» adivinaron dos veces.
//
// Además de validar, SANEA lo que es determinista: los atributos on* se
// quitan sin preguntar. Los dos modelos probados ponían onsubmit="return
// false" en el formulario aunque se les prohibiera; gastar una ronda de IA en
// borrar un atributo no tiene sentido.
// =============================================================================

/** Lo que una plantilla puede leer. Todo lo demás es un hueco inventado que
 *  se pintaría vacío sin avisar. */
const ROOT_FIELDS = new Set([
  // contenido (site-content.ts)
  'titular', 'subtitulo', 'sobre', 'llamada_accion', 'servicios', 'cifras', 'proceso', 'precios', 'garantias', 'zona', 'faq', 'horario',
  // derivados que pone el motor
  'sobre_html', 'horario_resumen', 'ancla', 'menu', 'secciones', 'pagina', 'formulario', 'fotos', 'anio', 'legales',
  // el blog (entrega 5): blog = {titulo, intro, href}; entradas en la lista; entrada en el artículo
  'blog', 'entradas', 'entrada',
  // negocio
  'nombre', 'telefono', 'telefono_href', 'direccion', 'maps_url', 'valoracion', 'num_resenas',
  // Google en vivo, solo en el borrador
  'resenas_html', 'citas_html', 'atribucion_google_html',
]);
/** Campos de los elementos de las listas y de los bloques. */
const ITEM_FIELDS = new Set([
  'nombre', 'descripcion', 'icono', 'valor', 'etiqueta', 'titulo', 'texto', 'texto_html', 'concepto', 'precio', 'detalle',
  'nota', 'filas', 'lugares', 'pregunta', 'respuesta', 'respuesta_html', 'dias', 'horas', 'href', 'actual', 'length',
  'foto', 'fotoAlt', 'items', 'id', 'tipo', 'portada', 'equipo', 'trabajo', 'muestra', 'meta_titulo', 'meta_descripcion',
  'ruta', 'inicio', 'fecha', 'fecha_iso', 'extracto', 'foto_alt', 'intro',
]);
/** Solo estos van con triple llave: son HTML que ya produjo el motor. Un
 *  campo de texto del cliente con triple llave sería una puerta a inyectar
 *  HTML en su propia web. */
const RAW_FIELDS = new Set(['secciones', 'sobre_html', 'respuesta_html', 'texto_html', 'resenas_html', 'citas_html', 'atribucion_google_html']);
const LIST_FIELDS = ['legales', 'servicios', 'cifras', 'proceso', 'garantias', 'faq', 'horario', 'precios.filas', 'zona.lugares', 'items', 'menu', 'entradas'];

const ALLOWED_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
/** Una plantilla generada pesa 30–60 KB; el tope es para que un desvarío del
 *  modelo no acabe en la web de un cliente. */
export const MAX_TEMPLATE_BYTES = 300_000;

export interface TemplateValidation {
  ok: boolean;
  problems: string[];
  /** La plantilla con lo determinista ya arreglado (atributos on*). */
  template: SiteTemplateSource;
  removedAttributes: string[];
}

function stripEventAttributes(html: string, removed: string[]): string {
  return html.replace(/(<[a-zA-Z][^>]*?)\s(on[a-z]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g, (_m, pre: string, attr: string) => {
    removed.push(attr);
    return pre;
  });
}

function visibleText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/i, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\{\{\{?[^}]*\}?\}\}/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ');
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function checkPart(name: 'marco' | SiteTemplatePart, source: string, problems: string[]): void {
  const where = name === 'marco' ? 'el marco' : `la sección «${name}»`;
  let tags: ReturnType<typeof collectTags>;
  try {
    tags = collectTags(parseMustache(source));
  } catch (err) {
    problems.push(`${where}: ${err instanceof TemplateSyntaxError ? err.message : 'Mustache mal formado'}.`);
    return;
  }
  for (const tag of tags) {
    const head = tag.name.split('.')[0];
    if (!ROOT_FIELDS.has(head) && !ITEM_FIELDS.has(head)) {
      problems.push(`${where}: el hueco {{${tag.name}}} no existe. Usa solo los campos del esquema.`);
    }
    if (tag.raw && !RAW_FIELDS.has(tag.name.split('.').pop() as string)) {
      problems.push(`${where}: {{{${tag.name}}}} va con triple llave y es texto del cliente. Usa {{${tag.name}}} (doble llave), que lo escapa.`);
    }
  }
  // {{#lista}} alrededor de otro {{#lista}}: la sección sale repetida una vez
  // por elemento (Mustache recorre las listas). Pasó en la prueba del 26/10.
  for (const list of LIST_FIELDS) {
    const re = new RegExp(`\\{\\{#${list.replace('.', '\\.')}\\}\\}([\\s\\S]*?)\\{\\{/${list.replace('.', '\\.')}\\}\\}`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) {
      if (m[1].includes(`{{#${list}}}`)) {
        problems.push(
          `${where} (línea ${lineOf(source, m.index)}): {{#${list}}} envuelve otro {{#${list}}}; como «${list}» es una lista, el de fuera repite el bloque una vez por elemento. Quita el de fuera: el motor ya no pinta las secciones vacías.`,
        );
      }
    }
  }
  if (/<iframe|<object|<embed/i.test(source)) problems.push(`${where}: no se permiten iframe, object ni embed.`);
  if (/javascript:/i.test(source)) problems.push(`${where}: no se permiten enlaces javascript:.`);
  for (const m of source.matchAll(/(?:src|href)\s*=\s*["'](?:https?:)?\/\/([^/"']+)([^"']*)/gi)) {
    const host = m[1].toLowerCase();
    if (!ALLOWED_HOSTS.has(host)) {
      problems.push(`${where}: carga un recurso de ${m[1]}. Solo se permiten Google Fonts; todo lo demás va dentro de la plantilla.`);
    } else if (!(m[2] === '' || m[2] === '/' || (host === 'fonts.googleapis.com' && /^\/css2?\?/.test(m[2])))) {
      // 27/10/2026 — el motor sirve las tipografías desde la propia web
      // cambiando el <link> de css2; cualquier otro enlace a Google (un
      // preload de un .woff2 de gstatic) se quedaría pidiéndoselo a Google.
      problems.push(`${where}: enlaza ${m[1]}${m[2]}. Las tipografías se declaran solo con el <link href="https://fonts.googleapis.com/css2?family=…"> del <head>.`);
    }
  }
  for (const m of source.matchAll(/url\(\s*["']?(?:https?:)?\/\/([^/"')]+)/gi)) {
    problems.push(
      ALLOWED_HOSTS.has(m[1].toLowerCase())
        ? `${where}: el CSS carga tipografías de Google con url() o @import. Decláralas solo con el <link> de Google Fonts del <head>.`
        : `${where}: el CSS carga ${m[1]}. Solo se permiten Google Fonts.`,
    );
  }
  const { unknown } = declaredFontFamilies(source);
  if (unknown.length) {
    problems.push(`${where}: las tipografías ${unknown.join(', ')} no están en el catálogo y no se servirían. Usa solo estas — ${fontCatalogForPrompt()}.`);
  }
  const digits = [...new Set(visibleText(source).match(/\d[\d.,:]*/g) ?? [])];
  if (digits.length) {
    problems.push(
      `${where}: hay cifras escritas en la plantilla (${digits.slice(0, 6).join(' ')}). Todo número sale del contenido; si es una numeración, hazla con contadores CSS.`,
    );
  }
  if (name !== 'marco') {
    if (!/\sid="\{\{ancla\}\}"/.test(source)) {
      problems.push(`${where}: el elemento exterior tiene que llevar id="{{ancla}}"; el menú y los enlaces internos apuntan ahí.`);
    }
    if (/<script/i.test(source)) problems.push(`${where}: el JavaScript va en el marco, no en las secciones.`);
    if (/<(html|head|body)\b/i.test(source)) problems.push(`${where}: una sección no lleva <html>, <head> ni <body>; eso es del marco.`);
  }
}

/**
 * Valida y sanea una plantilla. Devuelve la plantilla saneada aunque haya
 * problemas, para que la ronda de corrección trabaje sobre ella.
 */
export function validateSiteTemplate(input: SiteTemplateSource): TemplateValidation {
  const problems: string[] = [];
  const removed: string[] = [];
  const template: SiteTemplateSource = {
    marco: stripEventAttributes(input.marco ?? '', removed),
    secciones: Object.fromEntries(
      Object.entries(input.secciones ?? {}).map(([k, v]) => [k, stripEventAttributes(String(v ?? ''), removed)]),
    ),
    ...(input.estilo != null ? { estilo: input.estilo } : {}),
  };

  const size = Buffer.byteLength(template.marco) + Object.values(template.secciones).reduce((n, s) => n + Buffer.byteLength(s ?? ''), 0);
  if (size > MAX_TEMPLATE_BYTES) problems.push(`La plantilla pesa ${Math.round(size / 1024)} KB; el máximo son ${MAX_TEMPLATE_BYTES / 1000} KB.`);

  // El marco
  const marco = template.marco;
  checkPart('marco', marco, problems);
  for (const [re, msg] of [
    [/<html[\s>]/i, 'falta <html>'],
    [/<head[\s>]/i, 'falta <head>'],
    [/<body[\s>]/i, 'falta <body>'],
    [/<title>[^<]*\{\{pagina\.meta_titulo\}\}[^<]*<\/title>/i, 'el <title> tiene que ser {{pagina.meta_titulo}}'],
    [/\{\{#menu\}\}[\s\S]*\{\{href\}\}[\s\S]*\{\{titulo\}\}[\s\S]*\{\{\/menu\}\}|\{\{#menu\}\}[\s\S]*\{\{titulo\}\}[\s\S]*\{\{href\}\}[\s\S]*\{\{\/menu\}\}/, 'el menú tiene que ser {{#menu}}<a href="{{href}}">{{titulo}}</a>{{/menu}}: lo compone el motor'],
  ] as const) {
    if (!re.test(marco)) problems.push(`el marco: ${msg}.`);
  }
  for (const cls of ['dato-ejemplo', 'leyenda-ejemplos']) {
    if (!new RegExp(`\\.${cls}\\b`).test(marco)) {
      problems.push(`el marco: el CSS tiene que dar estilo a .${cls} (los datos de ejemplo y su leyenda los pone el motor; la plantilla decide cómo se ven).`);
    }
  }
  // 27/10/2026 — las citas y reseñas de Google las escribe el código
  // (site-draft-markup.ts, por las políticas de Places); la plantilla les da
  // estilo. Sin esto salían como una lista sin formato.
  for (const cls of ['cita', 'cita-autor', 'resena', 'resena-estrellas', 'atribucion-google']) {
    if (!new RegExp(`\\.${cls}(?![\\w-])`).test(marco)) {
      problems.push(`el marco: el CSS tiene que dar estilo a .${cls}; las citas y reseñas de Google llegan ya escritas con esas clases (ver los campos *_html).`);
    }
  }
  const holes = marco.match(/\{\{\{secciones\}\}\}/g)?.length ?? 0;
  if (holes !== 1) problems.push(`el marco: tiene que llevar {{{secciones}}} exactamente una vez (lleva ${holes}); ahí van las secciones en el orden del cliente.`);
  const scripts = marco.match(/<script\b/gi)?.length ?? 0;
  if (scripts > 1) problems.push(`el marco: lleva ${scripts} <script>; como mucho uno, al final del <body>.`);
  const script = marco.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i)?.[1] ?? '';
  if (/<script\b[^>]*\bsrc=/i.test(marco)) problems.push('el marco: el <script> no puede cargar archivos externos.');
  if (/\bfetch\s*\(|XMLHttpRequest|\beval\s*\(|new Function|import\s*\(|document\.cookie|localStorage|sendBeacon/.test(script)) {
    problems.push('el marco: el JavaScript de la plantilla es solo para el aspecto (menú, animaciones). No puede hacer peticiones, ni eval, ni tocar cookies o almacenamiento; el envío del formulario lo pone el sistema.');
  }

  // Entrega 5: la canónica, las tarjetas para redes y los datos estructurados
  // los pone el motor en cada página publicada (con la URL de cada una). Si
  // la plantilla también los pusiera, saldrían duplicados y contradictorios.
  if (/rel=["']canonical["']|property=["']og:|application\/ld\+json/i.test(marco)) {
    problems.push('el marco: no pongas <link rel="canonical">, etiquetas og: ni datos estructurados (ld+json); los pone el sistema en cada página publicada.');
  }

  // Las piezas
  for (const part of SITE_TEMPLATE_PARTS) {
    const source = template.secciones[part];
    if (!source || !source.trim()) {
      problems.push(`falta la sección «${part}». Toda plantilla trae las ${SITE_SECTION_TYPES.length} secciones, los 4 tipos de bloque libre y las 2 piezas del blog y la cabecera de página.`);
      continue;
    }
    checkPart(part, source, problems);
  }
  for (const extra of Object.keys(template.secciones)) {
    if (!(SITE_TEMPLATE_PARTS as readonly string[]).includes(extra)) problems.push(`sobra la sección «${extra}»: no existe en el esquema.`);
  }

  // El blog (entrega 5): la lista enlaza cada entrada y el artículo pinta su
  // texto. Sin esto, la página existe y sale vacía sin que nada falle.
  const lista = template.secciones.blog_lista ?? '';
  if (lista && !/\{\{#entradas\}\}[\s\S]*\{\{href\}\}[\s\S]*\{\{\/entradas\}\}/.test(lista)) {
    problems.push('la sección «blog_lista»: tiene que recorrer {{#entradas}}…{{/entradas}} con un enlace <a href="{{href}}">{{titulo}}</a> a cada entrada.');
  }
  const articulo = template.secciones.blog_articulo ?? '';
  if (articulo && (!articulo.includes('{{{entrada.texto_html}}}') || !articulo.includes('{{entrada.titulo}}'))) {
    problems.push('la sección «blog_articulo»: tiene que pintar {{entrada.titulo}} (en un <h1>) y el texto con {{{entrada.texto_html}}}.');
  }

  const cabecera = template.secciones.cabecera_pagina ?? '';
  if (cabecera && !/<h1\b[^>]*>[\s\S]*\{\{pagina\.titulo\}\}[\s\S]*<\/h1>/.test(cabecera)) {
    problems.push('la sección «cabecera_pagina»: tiene que llevar el título de la página en un <h1>: <h1>{{pagina.titulo}}</h1>.');
  }

  // El formulario: los nombres de campo que espera el buzón del portal
  // (website-form.ts) y la nota donde el motor escribe «Enviando…».
  const contacto = template.secciones.contacto ?? '';
  if (contacto) {
    for (const [re, what] of [
      [/<form\b[^>]*\bid="kairikos-form"/, '<form id="kairikos-form">'],
      [/\bname="name"/, 'un campo name="name" (nombre)'],
      [/\bname="contact"/, 'un campo name="contact" (teléfono o email)'],
      [/\bname="message"/, 'un campo name="message" (mensaje)'],
      [/\bid="kairikos-form-note"/, 'un elemento id="kairikos-form-note" hidden para los avisos'],
    ] as const) {
      if (!re.test(contacto)) problems.push(`la sección «contacto»: falta ${what}. El envío lo pone el sistema y busca exactamente eso.`);
    }
  }

  // Lo que el negocio puede cambiar (site-style.ts). Solo lo declaran las
  // escritas a mano; las de la IA no traen estilo y no admiten cambios.
  problems.push(...validateTemplateStyle(input.estilo, marco, declaredFontFamilies(marco).known));

  return { ok: problems.length === 0, problems, template, removedAttributes: removed };
}
