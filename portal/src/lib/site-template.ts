import {
  SITE_BLOCK_TYPES,
  SITE_SECTION_TYPES,
  type SiteBlock,
  type SiteContent,
  type SitePage,
  type SiteSectionType,
} from './site-content';
import { renderSiteMarkdown } from './site-markdown';

// =============================================================================
// Webs con IA, entrega 1 (27/10/2026) — el motor que convierte una PLANTILLA
// (diseño) y un CONTENIDO (site-content.ts) en las páginas de una web.
//
// Una plantilla son piezas de Mustache: un MARCO (cabecera, menú, pie, estilos,
// el JavaScript de la plantilla) y una pieza por cada sección y por cada tipo
// de bloque libre. Las diseña la IA (entrega 2) o se escriben a mano
// (site-template-base.ts); este archivo solo las rellena.
//
// Lo que decide el MOTOR y no la plantilla, porque en las pruebas del 26/10 la
// IA lo hacía mal de formas que no rompen nada visible:
// - Qué secciones se pintan. Una sección oculta por el cliente o sin datos no
//   se pinta, sin que la plantilla tenga que envolverla en nada. Antes, la IA
//   olvidaba envolver tres de cada siete y dejaba títulos huérfanos; y
//   envolver una sección con {{#lista}} la REPETÍA una vez por elemento.
// - El menú. Lo compone el motor con las secciones que sí se pintan (o con
//   las páginas, si hay varias): nunca apunta a una sección vacía.
// - El envío del formulario. La plantilla dibuja el formulario con los
//   nombres de campo acordados; el JavaScript que lo envía lo pone el motor,
//   el mismo que ya funciona en web-draft-html.ts. Una plantilla generada no
//   puede romper el canal por el que le llegan los clientes al negocio.
// - Las marcas de ejemplo. Cada valor cuya ruta está en content.ejemplos sale
//   envuelto en .dato-ejemplo; la plantilla solo le da estilo.
//
// Subconjunto de Mustache, y ninguno más (las plantillas que traigan otra
// cosa no pasan site-template-validate.ts):
//   {{campo}}        texto escapado            {{{campo}}}  HTML ya hecho
//   {{#campo}}…{{/campo}}  lista: repite; texto u objeto: muestra si tiene algo
//   {{^campo}}…{{/campo}}  muestra si está vacío
//   Campos con punto ({{precios.nota}}) y {{#lista.length}} para «una vez si
//   tiene elementos».
// =============================================================================

/** Las piezas de una plantilla además del marco. */
export const SITE_BLOCK_PARTS = SITE_BLOCK_TYPES.map((t) => `bloque_${t}` as const);
export type SiteTemplatePart = SiteSectionType | (typeof SITE_BLOCK_PARTS)[number];
export const SITE_TEMPLATE_PARTS: readonly SiteTemplatePart[] = [...SITE_SECTION_TYPES, ...SITE_BLOCK_PARTS];

export interface SiteTemplateSource {
  marco: string;
  secciones: Partial<Record<SiteTemplatePart, string>>;
}

// ---- Mustache: análisis --------------------------------------------------------

type MustacheNode =
  | string
  | { t: 'var'; name: string; raw: boolean }
  | { t: 'sec'; name: string; inverted: boolean; children: MustacheNode[] };

const TAG_RE = /\{\{(\{?)([#^/]?)\s*([a-zA-Z0-9_.]+)\s*\}?\}\}/g;

export class TemplateSyntaxError extends Error {}

export function parseMustache(source: string): MustacheNode[] {
  const root: MustacheNode[] = [];
  const stack: { name: string | null; children: MustacheNode[] }[] = [{ name: null, children: root }];
  let last = 0;
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(source))) {
    stack[stack.length - 1].children.push(source.slice(last, m.index));
    last = TAG_RE.lastIndex;
    const [, triple, sigil, name] = m;
    if (sigil === '#' || sigil === '^') {
      const node: MustacheNode = { t: 'sec', name, inverted: sigil === '^', children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push({ name, children: node.children });
    } else if (sigil === '/') {
      const top = stack.pop();
      if (!top || top.name !== name) {
        throw new TemplateSyntaxError(`{{/${name}}} cierra una sección que no está abierta (abierta: ${top?.name ?? 'ninguna'})`);
      }
    } else {
      stack[stack.length - 1].children.push({ t: 'var', name, raw: triple === '{' });
    }
  }
  stack[stack.length - 1].children.push(source.slice(last));
  if (stack.length !== 1) throw new TemplateSyntaxError(`{{#${stack[stack.length - 1].name}}} sin cerrar`);
  return root;
}

/** Todos los nombres que usa una plantilla, para el validador. */
export function collectTags(nodes: MustacheNode[], out: { name: string; raw: boolean; section: boolean }[] = []) {
  for (const n of nodes) {
    if (typeof n === 'string') continue;
    if (n.t === 'var') out.push({ name: n.name, raw: n.raw, section: false });
    else {
      out.push({ name: n.name, raw: false, section: true });
      collectTags(n.children, out);
    }
  }
  return out;
}

// ---- Mustache: pintado ---------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Un contexto lleva su valor y su RUTA dentro del contenido, para saber si un
 *  valor es un dato de ejemplo ('precios.filas.2' + 'precio'). */
interface Ctx {
  value: unknown;
  path: string | null;
}

function lookup(stack: Ctx[], name: string): { value: unknown; path: string | null } {
  for (let i = stack.length - 1; i >= 0; i--) {
    let value = stack[i].value;
    let path = stack[i].path;
    let found = true;
    for (const key of name.split('.')) {
      if (value != null && typeof value === 'object' && key in (value as object)) {
        value = (value as Record<string, unknown>)[key];
        path = path === null ? null : path ? `${path}.${key}` : key;
      } else {
        found = false;
        break;
      }
    }
    if (found) return { value, path };
  }
  return { value: undefined, path: null };
}

function isEmpty(value: unknown): boolean {
  if (value == null || value === false || value === 0 || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.values(value as object).every(isEmpty);
  return false;
}

function renderNodes(nodes: MustacheNode[], stack: Ctx[], examples: Set<string>): string {
  let out = '';
  for (const node of nodes) {
    if (typeof node === 'string') {
      out += node;
      continue;
    }
    const { value, path } = lookup(stack, node.name);
    if (node.t === 'var') {
      if (value == null || typeof value === 'object') continue;
      const s = node.raw ? String(value) : esc(String(value));
      // Los *_html son la versión ya formateada de un campo de texto: la marca
      // de ejemplo es la del campo original, y va en bloque porque dentro hay
      // párrafos y listas.
      const base = path?.endsWith('_html') ? path.slice(0, -5) : path;
      if (base && examples.has(base)) {
        out += path !== base ? `<div class="dato-ejemplo dato-ejemplo-bloque">${s}</div>` : `<span class="dato-ejemplo">${s}</span>`;
      } else {
        out += s;
      }
      continue;
    }
    const empty = isEmpty(value);
    if (node.inverted) {
      if (empty) out += renderNodes(node.children, stack, examples);
      continue;
    }
    if (empty) continue;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        out += renderNodes(node.children, [...stack, { value: item, path: path === null ? null : `${path}.${i}` }], examples);
      });
    } else if (typeof value === 'object') {
      out += renderNodes(node.children, [...stack, { value, path }], examples);
    } else {
      out += renderNodes(node.children, stack, examples);
    }
  }
  return out;
}

/** Pinta una pieza suelta. Exportado para el validador y las pruebas. */
export function renderMustache(source: string, view: object, examples: Iterable<string> = []): string {
  return renderNodes(parseMustache(source), [{ value: view, path: '' }], new Set(examples));
}

// ---- Qué se pinta --------------------------------------------------------------

/** Lo que aporta quien publica o enseña la web, no el contenido: los datos del
 *  negocio, las fotos, el formulario y, solo en el borrador, lo que viene de
 *  Google en vivo (que no se puede guardar; ver places-retention.ts). */
export interface SiteRenderContext {
  negocio: {
    nombre: string;
    telefono: string | null;
    direccion: string | null;
    mapsUrl: string | null;
    /** Solo con datos de verdad (reviews contratado, o Google en vivo en el
     *  borrador). Nunca una valoración inventada ni «0 reseñas». */
    valoracion: string | null;
    numResenas: string | null;
  };
  /** Rutas DENTRO del sitio ('assets/portada.jpg'); el motor les antepone
   *  lo que haga falta según la profundidad de cada página. */
  fotos: { portada: string | null; equipo: string | null; trabajo: string | null };
  /** URL del buzón del portal. Null = formulario de muestra (borrador). */
  formAction: string | null;
  /** Borrador: banda de propuesta, noindex y formulario de muestra. */
  borrador: boolean;
  bannerHtml?: string | null;
  /** Lo nuestro al final de la página (la oferta «La quiero» del borrador).
   *  Va con sus propios estilos en línea: es de Kairikos, no de su web. */
  footerHtml?: string | null;
  /** HTML ya hecho de Google en vivo, solo en el borrador. */
  resenasHtml?: string | null;
  citasHtml?: string | null;
  atribucionGoogleHtml?: string | null;
  /** Horario de Google en vivo (borrador); si no, el del contenido. */
  horario?: { dias: string; horas: string }[] | null;
  now?: Date;
}

/** La leyenda de los datos de ejemplo. La pone el motor, igual en todas las
 *  webs; la plantilla solo le da estilo (.leyenda-ejemplos). */
export const EXAMPLE_LEGEND_HTML =
  '<p class="leyenda-ejemplos" role="note">Los datos marcados son de ejemplo: usted los cambia o los quita antes de publicar.</p>';

/** El texto del menú de una web de una página, por sección. Las que no están
 *  aquí no salen en el menú. Orden = prioridad: caben cinco. */
const MENU_LABELS: Partial<Record<SiteSectionType, string>> = {
  servicios: 'Servicios',
  precios: 'Precios',
  opiniones: 'Opiniones',
  faq: 'Preguntas',
  sobre: 'Nosotros',
  zona: 'Zona',
  proceso: 'Cómo trabajamos',
};
export const MENU_MAX_LINKS = 5;

type View = Record<string, unknown>;

function phoneHref(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.length < 9) return null;
  return digits.startsWith('+') ? digits : `+34${digits}`;
}

/** Lo que ve una plantilla. Los datos del contenido van en la raíz, con su
 *  ruta, para que las marcas de ejemplo funcionen tal cual. */
function buildView(content: SiteContent, ctx: SiteRenderContext, base: string): View {
  const d = content.datos;
  const horario = ctx.horario && ctx.horario.length ? ctx.horario : d.horario;
  const prefix = (p: string | null) => (p && !/^(https?:)?\/\//.test(p) ? base + p : p);
  return {
    ...d,
    horario,
    horario_resumen: horario.length === 1 ? `${horario[0].dias}, ${horario[0].horas}` : '',
    sobre_html: renderSiteMarkdown(d.sobre),
    faq: d.faq.map((f) => ({ ...f, respuesta_html: renderSiteMarkdown(f.respuesta) })),
    nombre: ctx.negocio.nombre,
    telefono: ctx.negocio.telefono ?? '',
    telefono_href: phoneHref(ctx.negocio.telefono) ?? '',
    direccion: ctx.negocio.direccion ?? '',
    maps_url: ctx.negocio.mapsUrl ?? '',
    valoracion: ctx.negocio.valoracion ?? '',
    num_resenas: ctx.negocio.numResenas ?? '',
    resenas_html: ctx.resenasHtml ?? '',
    citas_html: ctx.citasHtml ?? '',
    atribucion_google_html: ctx.atribucionGoogleHtml ?? '',
    fotos: {
      portada: prefix(ctx.fotos.portada) ?? '',
      equipo: prefix(ctx.fotos.equipo) ?? '',
      trabajo: prefix(ctx.fotos.trabajo) ?? '',
    },
    formulario: { muestra: !ctx.formAction },
    // Para el «© año» del pie: la plantilla no puede escribir cifras.
    anio: String((ctx.now ?? new Date()).getFullYear()),
  };
}

/** Si una sección tiene algo que enseñar. Las fijas (portada, llamada,
 *  contacto) siempre: son las que llevan el teléfono. */
export function sectionHasContent(tipo: SiteSectionType, view: View): boolean {
  const d = view as unknown as SiteContent['datos'] & { valoracion: string; resenas_html: string };
  switch (tipo) {
    case 'portada':
    case 'llamada':
    case 'contacto':
      return true;
    case 'cifras':
      return d.cifras.length > 0;
    case 'servicios':
      return d.servicios.length > 0;
    case 'sobre':
      return d.sobre.trim() !== '';
    case 'proceso':
      return d.proceso.length > 0;
    case 'garantias':
      return d.garantias.length > 0;
    case 'precios':
      return d.precios.filas.length > 0;
    case 'opiniones':
      return Boolean(d.valoracion) || Boolean(d.resenas_html);
    case 'faq':
      return d.faq.length > 0;
    case 'zona':
      return d.zona.texto.trim() !== '' || d.zona.lugares.length > 0;
  }
}

/** La ruta del archivo de una página y lo que hay que anteponer a los enlaces
 *  relativos desde ella. */
export function pageFile(ruta: string): { path: string; base: string } {
  if (!ruta) return { path: 'index.html', base: '' };
  return { path: `${ruta}/index.html`, base: '../'.repeat(ruta.split('/').length) };
}

interface RenderedSection {
  kind: 'section' | 'block';
  anchor: string;
  tipo: SiteSectionType | 'bloque';
  html: string;
}

function blockView(block: SiteBlock, base: string): View {
  // La foto de un bloque es una ruta dentro del sitio: desde una página
  // anidada hay que subir de nivel, igual que con las fotos del negocio.
  const foto = block.foto && !/^(https?:)?\/\//.test(block.foto) ? base + block.foto : block.foto;
  return { ...block, foto, texto_html: renderSiteMarkdown(block.texto) };
}

function renderSections(
  template: SiteTemplateSource,
  content: SiteContent,
  page: SitePage,
  view: View,
): RenderedSection[] {
  const examples = new Set(content.ejemplos);
  const rendered: RenderedSection[] = [];
  for (const ref of page.secciones) {
    if (ref.oculta) continue;
    if (ref.tipo === 'bloque') {
      const block = content.bloques.find((b) => b.id === ref.id);
      const source = block ? template.secciones[`bloque_${block.tipo}`] : undefined;
      if (!block || !source) continue;
      if (!block.titulo && !block.texto && block.items.length === 0) continue;
      const anchor = `bloque-${block.id}`;
      const stack: Ctx[] = [
        { value: { ...view, ancla: anchor }, path: '' },
        { value: blockView(block, pageFile(page.ruta).base), path: `bloques.${block.id}` },
      ];
      rendered.push({ kind: 'block', anchor, tipo: 'bloque', html: renderNodes(parseMustache(source), stack, examples) });
      continue;
    }
    const source = template.secciones[ref.tipo];
    if (!source || !sectionHasContent(ref.tipo, view)) continue;
    rendered.push({
      kind: 'section',
      anchor: ref.tipo,
      tipo: ref.tipo,
      html: renderNodes(parseMustache(source), [{ value: { ...view, ancla: ref.tipo }, path: '' }], examples),
    });
  }
  return rendered;
}

/** El menú: con varias páginas, las páginas; con una, las secciones que se
 *  han pintado, por prioridad, hasta cinco, y Contacto siempre la última. */
export function buildMenu(
  content: SiteContent,
  page: SitePage,
  rendered: Pick<RenderedSection, 'kind' | 'tipo' | 'anchor'>[],
): { titulo: string; href: string; actual: boolean }[] {
  const { base } = pageFile(page.ruta);
  if (content.paginas.length > 1) {
    return content.paginas.slice(0, 8).map((p) => ({
      titulo: p.titulo,
      href: p.ruta ? `${base}${p.ruta}/` : base || './',
      actual: p.ruta === page.ruta,
    }));
  }
  const present = new Set(rendered.filter((r) => r.kind === 'section').map((r) => r.tipo));
  const links = (Object.keys(MENU_LABELS) as SiteSectionType[])
    .filter((tipo) => present.has(tipo))
    .slice(0, present.has('contacto') ? MENU_MAX_LINKS - 1 : MENU_MAX_LINKS)
    .map((tipo) => ({ titulo: MENU_LABELS[tipo] as string, href: `#${tipo}`, actual: false }));
  if (present.has('contacto')) links.push({ titulo: 'Contacto', href: '#contacto', actual: false });
  return links;
}

/** El envío del formulario: el mismo comportamiento que web-draft-html.ts, que
 *  es el que ya funciona en producción. Si el envío falla se enseña el
 *  teléfono: un formulario mudo es peor que no tenerlo. */
function formScript(action: string, phone: string | null, href: string | null): string {
  const fallback =
    phone && href
      ? `No hemos podido enviarlo. Llámenos al <a href="tel:${esc(href)}">${esc(phone)}</a>.`
      : 'No hemos podido enviarlo. Inténtelo de nuevo en un momento.';
  return `<script>
(function () {
  var form = document.getElementById("kairikos-form");
  var note = document.getElementById("kairikos-form-note");
  if (!form || !note) return;
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var data = new FormData(form);
    note.hidden = false;
    note.textContent = "Enviando…";
    fetch(${JSON.stringify(action)}, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: String(data.get("name") || ""),
        contact: String(data.get("contact") || ""),
        message: String(data.get("message") || "")
      })
    })
      .then(function (res) {
        if (!res.ok) throw new Error("bad_status");
        form.reset();
        note.textContent = "Recibido. Le respondemos enseguida.";
      })
      .catch(function () { note.innerHTML = ${JSON.stringify(fallback)}; });
  });
})();
</script>`;
}

/** Pinta una página completa. */
export function renderSitePage(template: SiteTemplateSource, content: SiteContent, page: SitePage, ctx: SiteRenderContext): string {
  const { base } = pageFile(page.ruta);
  const view = buildView(content, ctx, base);
  const rendered = renderSections(template, content, page, view);
  const menu = buildMenu(content, page, rendered);
  const isHome = page.ruta === '';
  const metaTitulo =
    page.metaTitulo || (isHome ? content.datos.titular : `${page.titulo} · ${ctx.negocio.nombre}`) || ctx.negocio.nombre;
  const metaDescripcion = page.metaDescripcion || content.datos.subtitulo;
  let html = renderNodes(
    parseMustache(template.marco),
    [
      {
        value: {
          ...view,
          menu,
          secciones: rendered.map((r) => r.html).join('\n'),
          pagina: { titulo: page.titulo, ruta: page.ruta, meta_titulo: metaTitulo, meta_descripcion: metaDescripcion, inicio: base || './' },
        },
        path: '',
      },
    ],
    new Set(content.ejemplos),
  );

  // Lo que pone el motor en toda página, sin depender de que la plantilla se
  // acuerde: noindex en el borrador (es una propuesta sobre un negocio de
  // terceros), la banda de propuesta y el envío del formulario.
  if (ctx.borrador) {
    html = html.replace(/<\/head>/i, '<meta name="robots" content="noindex, nofollow">\n</head>');
    if (ctx.bannerHtml) html = html.replace(/(<body[^>]*>)/i, `$1\n${ctx.bannerHtml}`);
  }
  if (ctx.footerHtml) html = html.replace(/<\/body>/i, `${ctx.footerHtml}\n</body>`);
  if (html.includes('class="dato-ejemplo')) {
    html = html.replace(/<\/body>/i, `${EXAMPLE_LEGEND_HTML}\n</body>`);
  }
  if (ctx.formAction && rendered.some((r) => r.tipo === 'contacto')) {
    html = html.replace(/<\/body>/i, `${formScript(ctx.formAction, ctx.negocio.telefono, phoneHref(ctx.negocio.telefono))}\n</body>`);
  }
  return html;
}

export interface SiteFile {
  path: string;
  content: Buffer;
}

/** Todas las páginas de la web. Las fotos las añade quien construye
 *  (website-build.ts), que es quien sabe de dónde salen. */
export function renderSiteFiles(template: SiteTemplateSource, content: SiteContent, ctx: SiteRenderContext): SiteFile[] {
  return content.paginas.map((page) => ({
    path: pageFile(page.ruta).path,
    content: Buffer.from(renderSitePage(template, content, page, ctx), 'utf8'),
  }));
}
