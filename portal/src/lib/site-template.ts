import {
  SITE_BLOCK_TYPES,
  SITE_SECTION_TYPES,
  publishedEntries,
  type SiteBlock,
  type SiteBlogEntry,
  type SiteContent,
  type SitePage,
  type SiteSectionType,
} from './site-content';
import { renderSiteMarkdown } from './site-markdown';
import { LEGAL_PAGES, legalPageMarkdown } from './site-legal';
import { localizeGoogleFonts } from './site-fonts';
import { sanitizeArticleHtml, toPlainText } from './seo-article-html';

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
/** Entrega 5: la lista del blog (blog/) y el artículo (blog/<slug>/). */
export const SITE_BLOG_PARTS = ['blog_lista', 'blog_articulo'] as const;
/** Entrega 5: la cabecera de una página interior (su <h1> con el título). La
 *  pone el motor en toda página que no sea la portada ni tenga la sección
 *  portada: sin ella, «Desatascos en Telde» no tenía h1 ni se veía su nombre. */
export const SITE_PAGE_PARTS = ['cabecera_pagina'] as const;
export type SiteTemplatePart =
  | SiteSectionType
  | (typeof SITE_BLOCK_PARTS)[number]
  | (typeof SITE_BLOG_PARTS)[number]
  | (typeof SITE_PAGE_PARTS)[number];
export const SITE_TEMPLATE_PARTS: readonly SiteTemplatePart[] = [...SITE_SECTION_TYPES, ...SITE_BLOCK_PARTS, ...SITE_BLOG_PARTS, ...SITE_PAGE_PARTS];

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
  /** Web publicada (entrega 4): añade aviso legal, privacidad y cookies,
   *  y sus enlaces en el pie. El borrador no las lleva: no es una web. */
  legales?: boolean;
  /** Entrega 5: la dirección pública de la web, con barra final
   *  ('https://fontaneriasuarez.es/'). Con ella salen la canónica, el mapa del
   *  sitio y las URL absolutas de las tarjetas para redes y de los datos
   *  estructurados. Sin ella (o en el borrador), no. */
  siteUrl?: string | null;
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
    legales: ctx.legales ? LEGAL_PAGES.map((p) => ({ titulo: p.titulo, href: `${base}${p.ruta}/` })) : [],
    // Entrega 5: para que el marco pueda enlazar al blog (en el pie, por
    // ejemplo). Vacío si no hay ninguna entrada publicada.
    blog: publishedEntries(content).length ? { titulo: content.blog.titulo, intro: content.blog.intro, href: `${base}blog/` } : '',
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
  tipo: SiteSectionType | 'bloque' | 'blog';
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

type MenuLink = { titulo: string; href: string; actual: boolean };

/**
 * El menú de `page`, con los enlaces relativos a ella.
 *
 * - Varias páginas: las páginas en el orden del cliente, menos la portada (la
 *   marca de la cabecera ya lleva a ella), hasta cinco.
 * - Una página: las secciones pintadas en la PORTADA (`homeRendered`), por
 *   prioridad, y Contacto siempre la última. Desde otra página (legales,
 *   blog) los anclas suben de nivel: ../#servicios.
 *
 * Entrega 5: si hay entradas publicadas, «Blog» entra siempre, delante de la
 * última página o de Contacto. Cabe porque se le quita sitio a otro enlace:
 * el menú de escritorio va en una línea y las comprobaciones lo miden.
 */
export function buildMenu(
  content: SiteContent,
  page: Pick<SitePage, 'ruta'>,
  homeRendered: Pick<RenderedSection, 'kind' | 'tipo' | 'anchor'>[],
): MenuLink[] {
  const { base } = pageFile(page.ruta);
  const blog: MenuLink[] = publishedEntries(content).length
    ? [{ titulo: content.blog.titulo, href: `${base}blog/`, actual: page.ruta === 'blog' || page.ruta.startsWith('blog/') }]
    : [];
  if (content.paginas.length > 1) {
    const pages = content.paginas
      .filter((p) => p.ruta !== '')
      .map((p) => ({ titulo: p.titulo, href: `${base}${p.ruta}/`, actual: p.ruta === page.ruta }))
      .slice(0, MENU_MAX_LINKS - blog.length);
    // Delante de la última solo si es la de contacto (lo habitual es que
    // cierre el menú); si no, al final.
    const last = content.paginas.filter((p) => p.ruta !== '').slice(0, pages.length).at(-1);
    const contactLast = Boolean(last?.secciones.some((s) => s.tipo === 'contacto' && !s.oculta));
    return blog.length && contactLast ? [...pages.slice(0, -1), ...blog, pages[pages.length - 1]] : [...pages, ...blog];
  }
  const present = new Set(homeRendered.filter((r) => r.kind === 'section').map((r) => r.tipo));
  const links = (Object.keys(MENU_LABELS) as SiteSectionType[])
    .filter((tipo) => present.has(tipo))
    .slice(0, MENU_MAX_LINKS - blog.length - (present.has('contacto') ? 1 : 0))
    .map((tipo) => ({ titulo: MENU_LABELS[tipo] as string, href: `${base}#${tipo}`, actual: false }));
  links.push(...blog);
  if (present.has('contacto')) links.push({ titulo: 'Contacto', href: `${base}#contacto`, actual: false });
  return links;
}

/**
 * Entrega 5 — los anclas a secciones que están en OTRA página. Una plantilla
 * escribe href="#contacto" en el botón de la portada sin saber si el
 * formulario está en la misma página o en «Contacto». El motor sí lo sabe:
 * lo apunta a la página que tiene esa sección; si no la tiene ninguna, al
 * teléfono (para «contacto») o lo deja (un ancla sin destino no hace nada).
 * Solo toca anclas de secciones y bloques: #contenido, #menu o los iconos
 * (#i-…) son del propio documento.
 */
function fixCrossPageAnchors(
  html: string,
  ruta: string,
  anchorsByPage: Map<string, Set<string>>,
  telHref: string | null,
): string {
  const here = anchorsByPage.get(ruta) ?? new Set<string>();
  const { base } = pageFile(ruta);
  const sections = new Set<string>(SITE_SECTION_TYPES);
  return html.replace(/(<a\b[^>]*?\shref=")#([a-z0-9-]+)"/g, (match, pre: string, anchor: string) => {
    if (!sections.has(anchor) && !anchor.startsWith('bloque-')) return match;
    if (here.has(anchor)) return match;
    for (const [other, anchors] of anchorsByPage) {
      if (anchors.has(anchor)) return `${pre}${base}${other ? `${other}/` : ''}#${anchor}"`;
    }
    return anchor === 'contacto' && telHref ? `${pre}tel:${telHref}"` : match;
  });
}

/** «20 de octubre de 2026». En UTC: la fecha es un día, no un instante. */
export function formatEntryDate(fecha: string): string {
  return new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${fecha}T00:00:00Z`));
}

/** El extracto de la lista: el que escribió el cliente o el principio del
 *  texto, sin marcas de formato y cortado en una palabra. */
export function entryExcerpt(entry: Pick<SiteBlogEntry, 'extracto' | 'texto'> & { html?: string }, max = 180): string {
  if (entry.extracto.trim()) return entry.extracto.trim();
  // Las del SEO traen HTML: se le quitan las etiquetas (toPlainText es la
  // misma limpieza que se usa para títulos).
  const plain = (entry.html ? toPlainText(entry.html.replace(/<\/(p|h[2-6]|li)>/g, ' ')) : entry.texto)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{2,3} +/gm, '')
    .replace(/^[-*] +|^\d{1,2}[.)] +/gm, '')
    .replace(/\*+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 30)).trim()}…`;
}

function entryView(entry: SiteBlogEntry, base: string): View {
  const foto = entry.foto && !/^(https?:)?\/\//.test(entry.foto) ? base + entry.foto : entry.foto;
  return {
    titulo: entry.titulo,
    href: `${base}blog/${entry.slug}/`,
    fecha: formatEntryDate(entry.fecha),
    fecha_iso: entry.fecha,
    extracto: entryExcerpt(entry),
    foto,
    foto_alt: entry.fotoAlt,
    // El HTML del SEO se limpia al pintarlo además de al guardarlo: el campo
    // también lo puede mandar el editor del cliente, y una web alojada se
    // sirve desde el dominio del portal.
    texto_html: entry.html ? sanitizeArticleHtml(entry.html) : renderSiteMarkdown(entry.texto),
  };
}

/** Si la plantilla no trae las piezas del blog (las de antes de la entrega
 *  5), una versión sencilla con clases propias. Feo pero digno; las
 *  plantillas nuevas no pasan el validador sin las suyas. */
const BLOG_FALLBACK: Record<(typeof SITE_BLOG_PARTS)[number] | (typeof SITE_PAGE_PARTS)[number], string> = {
  cabecera_pagina: '<header id="{{ancla}}" style="max-width:72rem;margin:0 auto;padding:3rem 1rem 0"><h1>{{pagina.titulo}}</h1></header>',
  blog_lista: `<section id="{{ancla}}" style="max-width:46rem;margin:0 auto;padding:3rem 1rem"><h1>{{blog.titulo}}</h1>{{#blog.intro}}<p>{{blog.intro}}</p>{{/blog.intro}}{{#entradas}}<article style="margin-top:2rem"><h2><a href="{{href}}">{{titulo}}</a></h2><p><time datetime="{{fecha_iso}}">{{fecha}}</time></p><p>{{extracto}}</p></article>{{/entradas}}</section>`,
  blog_articulo: `<article id="{{ancla}}" style="max-width:46rem;margin:0 auto;padding:3rem 1rem;overflow-wrap:anywhere"><p><a href="{{blog.href}}">{{blog.titulo}}</a></p><h1>{{entrada.titulo}}</h1><p><time datetime="{{entrada.fecha_iso}}">{{entrada.fecha}}</time></p>{{#entrada.foto}}<img src="{{entrada.foto}}" alt="{{entrada.foto_alt}}" style="max-width:100%;height:auto">{{/entrada.foto}}{{{entrada.texto_html}}}</article>`,
};

function renderBlogPart(template: SiteTemplateSource, part: (typeof SITE_BLOG_PARTS)[number] | (typeof SITE_PAGE_PARTS)[number], view: View): string {
  return renderNodes(parseMustache(template.secciones[part] ?? BLOG_FALLBACK[part]), [{ value: view, path: '' }], new Set());
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

/** Pinta una página completa. `menu` lo fija quien pinta una página que no
 *  está en el contenido (las legales): enlaza a las secciones de la portada. */
export function renderSitePage(
  template: SiteTemplateSource,
  content: SiteContent,
  page: SitePage,
  ctx: SiteRenderContext,
  options: {
    menu?: ReturnType<typeof buildMenu>;
    /** Lo que va en {{{secciones}}} cuando la página no sale de la lista
     *  de secciones (la lista del blog, un artículo). */
    body?: RenderedSection[];
    /** Las secciones de cada página, para apuntar los anclas que viven en
     *  otra (fixCrossPageAnchors). Solo lo pasa renderSiteFiles. */
    anchorsByPage?: Map<string, Set<string>>;
    /** Datos estructurados (schema.org) propios de esta página. */
    jsonLd?: object[];
    ogType?: 'website' | 'article';
    ogImage?: string | null;
  } = {},
): string {
  const { base } = pageFile(page.ruta);
  const view = buildView(content, ctx, base);
  const rendered = options.body ?? renderSections(template, content, page, view);
  if (!options.body && page.ruta !== '' && !rendered.some((r) => r.tipo === 'portada')) {
    const html = renderBlogPart(template, 'cabecera_pagina', { ...view, ancla: 'cabecera', pagina: { titulo: page.titulo } });
    rendered.unshift({ kind: 'block', anchor: 'cabecera', tipo: 'bloque', html });
  }
  const menu = options.menu ?? buildMenu(content, page, rendered);
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
  // Los enlaces legales tienen que estar en toda página publicada. Si la
  // plantilla no los pinta en su pie ({{#legales}}), los pone el motor.
  if (ctx.legales && !template.marco.includes('{{#legales}}')) {
    const links = (view.legales as { titulo: string; href: string }[])
      .map((l) => `<a href="${esc(l.href)}" style="color:inherit">${esc(l.titulo)}</a>`)
      .join(' · ');
    html = html.replace(/<\/body>/i, `<nav class="legales" aria-label="Legal" style="text-align:center;font-size:13px;padding:16px">${links}</nav>\n</body>`);
  }
  if (html.includes('class="dato-ejemplo')) {
    html = html.replace(/<\/body>/i, `${EXAMPLE_LEGEND_HTML}\n</body>`);
  }
  if (ctx.formAction && rendered.some((r) => r.tipo === 'contacto')) {
    html = html.replace(/<\/body>/i, `${formScript(ctx.formAction, ctx.negocio.telefono, phoneHref(ctx.negocio.telefono))}\n</body>`);
  }
  if (options.anchorsByPage) {
    html = fixCrossPageAnchors(html, page.ruta, options.anchorsByPage, phoneHref(ctx.negocio.telefono));
  }
  if (!ctx.borrador) {
    html = html.replace(/<\/head>/i, `${headMeta(ctx, page, metaTitulo, metaDescripcion, { ...options, verificacion: page.ruta === '' ? content.verificacionGoogle : '' })}\n</head>`);
  }
  // Tipografías desde la propia web, nunca desde Google (site-fonts.ts). El
  // borrador lo sirve siempre el portal; la web publicada lleva su copia.
  return localizeGoogleFonts(html, ctx.borrador ? '/' : base);
}

export interface SiteFile {
  path: string;
  content: Buffer;
}

/** Todas las páginas de la web: las del contenido, el blog (entrega 5), las
 *  legales y, publicada con dirección conocida, sitemap.xml y robots.txt. Las
 *  fotos y las tipografías las añade quien construye (website-build.ts). */
export function renderSiteFiles(template: SiteTemplateSource, content: SiteContent, ctx: SiteRenderContext): SiteFile[] {
  const file = (path: string, html: string): SiteFile => ({ path, content: Buffer.from(html, 'utf8') });
  const home = content.paginas.find((p) => p.ruta === '') ?? content.paginas[0];

  // Qué secciones acaba pintando cada página: para el menú de una web de una
  // página (sale de la portada) y para los anclas entre páginas.
  const anchorsByPage = new Map<string, Set<string>>();
  let homeRendered: RenderedSection[] = [];
  for (const page of content.paginas) {
    const rendered = renderSections(template, content, page, buildView(content, ctx, pageFile(page.ruta).base));
    anchorsByPage.set(page.ruta, new Set(rendered.map((r) => r.anchor)));
    if (page === home) homeRendered = rendered;
  }
  const menuFor = (ruta: string) => buildMenu(content, { ruta }, homeRendered);
  const published = !ctx.borrador;

  const files = content.paginas.map((page) =>
    file(
      pageFile(page.ruta).path,
      renderSitePage(template, content, page, ctx, {
        menu: menuFor(page.ruta),
        anchorsByPage,
        jsonLd: page === home && published ? [localBusinessLd(content, ctx)] : undefined,
      }),
    ),
  );

  // El blog: la lista y una página por entrada, cada una con la llamada final
  // debajo (quien lee un consejo es quien acaba llamando).
  const entries = publishedEntries(content);
  if (entries.length) {
    const nombre = ctx.negocio.nombre;
    const llamada = (ruta: string) =>
      renderSections(template, content, { ruta, titulo: '', metaTitulo: '', metaDescripcion: '', secciones: [{ tipo: 'llamada' }] }, buildView(content, ctx, pageFile(ruta).base));
    const listPage: SitePage = {
      ruta: 'blog',
      titulo: content.blog.titulo,
      metaTitulo: `${content.blog.titulo} · ${nombre}`,
      metaDescripcion: content.blog.intro || `Artículos y consejos de ${nombre}.`,
      secciones: [],
    };
    const listBase = pageFile('blog').base;
    const listView = { ...buildView(content, ctx, listBase), ancla: 'blog', entradas: entries.map((e) => entryView(e, listBase)) };
    files.push(
      file(
        'blog/index.html',
        renderSitePage(template, content, listPage, ctx, {
          menu: menuFor('blog'),
          anchorsByPage,
          body: [{ kind: 'section', anchor: 'blog', tipo: 'blog', html: renderBlogPart(template, 'blog_lista', listView) }, ...llamada('blog')],
        }),
      ),
    );
    for (const entry of entries) {
      const ruta = `blog/${entry.slug}`;
      const base = pageFile(ruta).base;
      const view = { ...buildView(content, ctx, base), ancla: 'articulo', entrada: entryView(entry, base) };
      const page: SitePage = {
        ruta,
        titulo: entry.titulo,
        // Con el nombre si cabe en los ~70 caracteres que enseña Google; si
        // no, solo el título: cortado a mitad de palabra queda peor.
        metaTitulo: entry.metaTitulo || (`${entry.titulo} · ${nombre}`.length <= 70 ? `${entry.titulo} · ${nombre}` : entry.titulo),
        metaDescripcion: entry.metaDescripcion || entryExcerpt(entry, 155),
        secciones: [],
      };
      files.push(
        file(
          pageFile(ruta).path,
          renderSitePage(template, content, page, ctx, {
            menu: menuFor(ruta),
            anchorsByPage,
            body: [{ kind: 'section', anchor: 'articulo', tipo: 'blog', html: renderBlogPart(template, 'blog_articulo', view) }, ...llamada(ruta)],
            jsonLd: published ? [blogPostingLd(entry, ctx)] : undefined,
            ogType: 'article',
            ogImage: entry.foto || undefined,
          }),
        ),
      );
    }
  }

  // Las páginas legales: el texto (site-legal.ts) como un bloque de texto de
  // la plantilla, para que se vean con su diseño; sin formulario ni datos de
  // ejemplo.
  if (ctx.legales) {
    for (const legal of LEGAL_PAGES) {
      const { titulo, texto } = legalPageMarkdown(legal.ruta, content.legal, ctx.negocio.nombre);
      const page: SitePage = { ruta: legal.ruta, titulo, metaTitulo: `${titulo} · ${ctx.negocio.nombre}`, metaDescripcion: '', secciones: [{ tipo: 'bloque', id: 'legal' }] };
      const legalContent: SiteContent = {
        ...content,
        // Sin título: el h1 lo pone la cabecera de la página.
        bloques: [{ id: 'legal', tipo: 'texto', titulo: '', texto, foto: '', fotoAlt: '', items: [] }],
        ejemplos: [],
      };
      files.push(file(pageFile(legal.ruta).path, renderSitePage(template, legalContent, page, { ...ctx, formAction: null }, { menu: menuFor(legal.ruta), anchorsByPage })));
    }
  }

  // El mapa del sitio y robots.txt: solo publicada y sabiendo su dirección
  // (las URL de un sitemap son absolutas). Las legales no van: no son lo que
  // nadie busca, y Google las encuentra igual por el pie.
  if (published && ctx.siteUrl) {
    const urls: { loc: string; lastmod?: string }[] = [
      ...content.paginas.map((p) => ({ loc: p.ruta ? `${p.ruta}/` : '' })),
      ...(entries.length ? [{ loc: 'blog/', lastmod: entries[0].fecha }, ...entries.map((e) => ({ loc: `blog/${e.slug}/`, lastmod: e.fecha }))] : []),
    ];
    const body = urls.map((u) => `  <url><loc>${esc(ctx.siteUrl + u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`).join('\n');
    files.push(file('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`));
    files.push(file('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${ctx.siteUrl}sitemap.xml\n`));
  }
  return files;
}

// ---- Lo que va en el <head> de una web publicada (entrega 5) ---------------

/** Una ruta del sitio en absoluto, si se conoce la dirección de la web. */
function absoluteUrl(ctx: SiteRenderContext, path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^https?:\/\//.test(path)) return path;
  return ctx.siteUrl ? ctx.siteUrl + path.replace(/^\/+/, '') : null;
}

function ldScript(data: object): string {
  // «</script>» dentro de un texto del cliente cerraría la etiqueta.
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

/** La canónica, las tarjetas para redes (Open Graph) y los datos
 *  estructurados. Lo pone el motor, como el noindex del borrador: una
 *  plantilla que se olvidara no se notaría hasta mirar Search Console. */
function headMeta(
  ctx: SiteRenderContext,
  page: Pick<SitePage, 'ruta'>,
  title: string,
  description: string,
  options: { jsonLd?: object[]; ogType?: 'website' | 'article'; ogImage?: string | null; verificacion?: string },
): string {
  const url = ctx.siteUrl ? `${ctx.siteUrl}${page.ruta ? `${page.ruta}/` : ''}` : null;
  const image = absoluteUrl(ctx, options.ogImage ?? ctx.fotos.portada);
  const lines = [
    url ? `<link rel="canonical" href="${esc(url)}">` : '',
    // Entrega 6: la verificación de Search Console, solo en la portada.
    options.verificacion ? `<meta name="google-site-verification" content="${esc(options.verificacion)}">` : '',
    `<meta property="og:type" content="${options.ogType ?? 'website'}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    description ? `<meta property="og:description" content="${esc(description)}">` : '',
    `<meta property="og:site_name" content="${esc(ctx.negocio.nombre)}">`,
    '<meta property="og:locale" content="es_ES">',
    url ? `<meta property="og:url" content="${esc(url)}">` : '',
    image ? `<meta property="og:image" content="${esc(image)}">\n<meta name="twitter:card" content="summary_large_image">` : '',
    ...(options.jsonLd ?? []).map(ldScript),
  ];
  return lines.filter(Boolean).join('\n');
}

/** El negocio para Google: nombre, teléfono, dirección, zona. Solo con lo
 *  que el cliente tiene escrito: un dato estructurado vacío o inventado es
 *  peor que ninguno. Sin valoración: Google no la admite de uno mismo. */
function localBusinessLd(content: SiteContent, ctx: SiteRenderContext): object {
  const tel = phoneHref(ctx.negocio.telefono);
  const lugares = content.datos.zona.lugares.map((l) => l.nombre);
  const image = absoluteUrl(ctx, ctx.fotos.portada);
  return {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: ctx.negocio.nombre,
    ...(content.datos.subtitulo ? { description: content.datos.subtitulo } : {}),
    ...(ctx.siteUrl ? { url: ctx.siteUrl } : {}),
    ...(tel ? { telephone: tel } : {}),
    ...(ctx.negocio.direccion ? { address: { '@type': 'PostalAddress', streetAddress: ctx.negocio.direccion, addressCountry: 'ES' } } : {}),
    ...(image ? { image } : {}),
    ...(lugares.length ? { areaServed: lugares } : {}),
  };
}

function blogPostingLd(entry: SiteBlogEntry, ctx: SiteRenderContext): object {
  const url = ctx.siteUrl ? `${ctx.siteUrl}blog/${entry.slug}/` : null;
  const image = absoluteUrl(ctx, entry.foto || ctx.fotos.portada);
  const autor = { '@type': 'Organization', name: ctx.negocio.nombre, ...(ctx.siteUrl ? { url: ctx.siteUrl } : {}) };
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: entry.titulo.slice(0, 110),
    description: entryExcerpt(entry, 155),
    datePublished: entry.fecha,
    dateModified: entry.fecha,
    author: autor,
    publisher: autor,
    ...(url ? { mainEntityOfPage: url, url } : {}),
    ...(image ? { image } : {}),
  };
}
