import { z } from 'zod';

// =============================================================================
// Webs con IA, entrega 1 (27/10/2026) — el CONTENIDO de una web, separado de
// su diseño.
//
// Hasta hoy la web de un cliente era `ClientWebsite.copy` (WebDraftCopy:
// titular, subtítulo, servicios…) pintado por UNA plantilla escrita en código
// (web-draft-html.ts). Las pruebas del 26/10 con Fontanería Suárez dejaron
// claro el siguiente paso: la IA diseña una PLANTILLA con huecos y el
// contenido va aparte, como datos. Cambiar un precio no vuelve a llamar a la
// IA: rellenar la plantilla tarda un milisegundo. Ver «Diseño con IA» en el
// plan de negocio y site-template.ts.
//
// Por qué el esquema es FIJO y no lo inventa la IA en cada plantilla: es lo
// que edita el cliente. El editor (entrega 4) tiene que saber qué campos
// pintar, y una plantilla nueva no puede cambiarle el formulario a nadie.
// La plantilla elige CÓMO se ve cada sección, nunca QUÉ datos existen.
//
// Tres decisiones que vienen de las pruebas, escritas aquí para que no
// parezcan arbitrarias:
//
// 1. Páginas desde el principio. Hoy todas las webs son de una página, pero
//    el blog y el SEO sin WordPress (entregas 5 y 6) necesitan varias. Una
//    web de una página es simplemente `paginas` con un solo elemento.
// 2. Las secciones van en una LISTA ordenada y ocultable. Así el cliente
//    reordena, oculta o mete un bloque libre entre dos secciones sin tocar
//    el diseño. Qué se pinta lo decide el motor, no la plantilla: en la
//    prueba, la IA olvidaba envolver secciones opcionales y dejaba títulos
//    huérfanos y enlaces del menú a ninguna parte.
// 3. «ejemplos» marca lo INVENTADO. El borrador puede llevar precios, años o
//    garantías de muestra para que el dueño vea las posibilidades, pero cada
//    uno queda señalado (el motor lo envuelve en .dato-ejemplo) hasta que el
//    cliente lo confirma. Nunca reseñas, valoraciones ni nombres: eso no está
//    en este esquema y sale solo de Google o del producto reviews.
// =============================================================================

/** Las secciones que puede tener una página. El orden de esta lista es el
 *  orden por defecto de una web nueva. */
export const SITE_SECTION_TYPES = [
  'portada',
  'cifras',
  'servicios',
  'sobre',
  'proceso',
  'garantias',
  'precios',
  'opiniones',
  'faq',
  'zona',
  'llamada',
  'contacto',
] as const;
export type SiteSectionType = (typeof SITE_SECTION_TYPES)[number];

/** Los bloques libres: lo que el cliente añade cuando quiere decir algo que no
 *  cabe en ninguna sección («Nuestra historia», «Cerrado en agosto»). Toda
 *  plantilla tiene que traer los cuatro diseñados, para que un bloque añadido
 *  nunca parezca pegado de otra web. */
export const SITE_BLOCK_TYPES = ['texto', 'texto_foto', 'lista', 'aviso'] as const;
export type SiteBlockType = (typeof SITE_BLOCK_TYPES)[number];

/** Topes del esquema. Son también los de las pruebas de contenido exagerado:
 *  una plantilla tiene que aguantar exactamente esto sin desbordar. */
export const SITE_LIMITS = {
  servicios: 12,
  cifras: 4,
  proceso: 6,
  preciosFilas: 12,
  garantias: 4,
  lugares: 12,
  faq: 8,
  horario: 7,
  bloques: 12,
  bloqueItems: 8,
  paginas: 20,
  seccionesPorPagina: 30,
} as const;

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) => text(max).default('');

/** Ruta de una página: '' es la portada; si no, minúsculas, números y guiones,
 *  con barras para anidar ('servicios/desatascos'). Sin puntos ni '..': la
 *  ruta acaba siendo un nombre de archivo en el servidor del cliente. */
export const PAGE_PATH_RE = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*)?$/;

/** Ids de bloque e iconos: lo mismo, sin barras. Acaban en atributos HTML
 *  (id="bloque-…", href="#i-…") y en rutas de ejemplo. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const sectionRefSchema = z.union([
  z.object({ tipo: z.enum(SITE_SECTION_TYPES), oculta: z.boolean().optional() }),
  z.object({ tipo: z.literal('bloque'), id: z.string().regex(SLUG_RE).max(40), oculta: z.boolean().optional() }),
]);
export type SiteSectionRef = z.infer<typeof sectionRefSchema>;

const pageSchema = z.object({
  ruta: z.string().max(120).regex(PAGE_PATH_RE),
  /** Lo que sale en el menú. Corto a propósito: el menú de escritorio va en
   *  una línea, como mucho cinco enlaces de una o dos palabras. */
  titulo: text(30).min(1),
  /** <title> y meta description. Vacíos, el motor los compone con el nombre
   *  del negocio; el SEO (entrega 6) los rellena con lo que proponga. */
  metaTitulo: optionalText(70),
  metaDescripcion: optionalText(160),
  secciones: z.array(sectionRefSchema).max(SITE_LIMITS.seccionesPorPagina),
});
export type SitePage = z.infer<typeof pageSchema>;

const blockSchema = z.object({
  id: z.string().regex(SLUG_RE).max(40),
  tipo: z.enum(SITE_BLOCK_TYPES),
  titulo: optionalText(90),
  /** Formato básico (site-markdown.ts): negrita, cursiva, listas, enlaces. */
  texto: optionalText(2000),
  /** Ruta relativa dentro del sitio ('assets/historia.jpg'). Solo texto_foto. */
  foto: optionalText(200),
  fotoAlt: optionalText(160),
  items: z.array(z.object({ texto: text(160).min(1), icono: optionalText(40) })).max(SITE_LIMITS.bloqueItems).default([]),
});
export type SiteBlock = z.infer<typeof blockSchema>;

const datosSchema = z.object({
  titular: text(90).min(1),
  subtitulo: optionalText(220),
  /** Formato básico. */
  sobre: optionalText(1200),
  llamada_accion: optionalText(90),
  servicios: z
    .array(z.object({ nombre: text(80).min(1), descripcion: optionalText(300), icono: optionalText(40) }))
    .min(1)
    .max(SITE_LIMITS.servicios),
  cifras: z.array(z.object({ valor: text(30).min(1), etiqueta: optionalText(90) })).max(SITE_LIMITS.cifras).default([]),
  proceso: z.array(z.object({ titulo: text(80).min(1), texto: optionalText(300) })).max(SITE_LIMITS.proceso).default([]),
  precios: z
    .object({
      nota: optionalText(200),
      filas: z
        .array(z.object({ concepto: text(120).min(1), precio: text(40).min(1), detalle: optionalText(200) }))
        .max(SITE_LIMITS.preciosFilas)
        .default([]),
    })
    .default({ nota: '', filas: [] }),
  garantias: z.array(z.object({ titulo: text(80).min(1), texto: optionalText(300) })).max(SITE_LIMITS.garantias).default([]),
  zona: z
    .object({
      texto: optionalText(400),
      lugares: z.array(z.object({ nombre: text(60).min(1) })).max(SITE_LIMITS.lugares).default([]),
    })
    .default({ texto: '', lugares: [] }),
  /** La respuesta lleva formato básico. */
  faq: z.array(z.object({ pregunta: text(160).min(1), respuesta: optionalText(1200) })).max(SITE_LIMITS.faq).default([]),
  /** El horario es del CLIENTE, no de Google: el de Places no se puede
   *  guardar (condiciones de Google Maps, ver places-retention.ts). */
  horario: z.array(z.object({ dias: text(40).min(1), horas: text(60).min(1) })).max(SITE_LIMITS.horario).default([]),
});
export type SiteData = z.infer<typeof datosSchema>;

export const siteContentSchema = z
  .object({
    version: z.literal(2),
    paginas: z.array(pageSchema).min(1).max(SITE_LIMITS.paginas),
    datos: datosSchema,
    bloques: z.array(blockSchema).max(SITE_LIMITS.bloques).default([]),
    /** Rutas de los valores inventados: 'precios.filas.2.precio',
     *  'bloques.historia.texto'. Ver EXAMPLE_PATH_RE. */
    ejemplos: z.array(z.string().max(80)).max(200).default([]),
    /** Secciones que el cliente ha revisado y da por buenas (entrega 4). Por
     *  sección y no por campo: en la prueba, la IA marcaba como ejemplo las
     *  cifras pero no afirmaciones sin número como «el desplazamiento va
     *  incluido». Revisar la sección entera es lo único que lo cubre. */
    seccionesConfirmadas: z.array(z.string().max(60)).max(60).default([]),
  })
  .superRefine((c, ctx) => {
    const rutas = new Set<string>();
    c.paginas.forEach((p, i) => {
      if (rutas.has(p.ruta)) ctx.addIssue({ code: 'custom', path: ['paginas', i, 'ruta'], message: 'duplicate_page_path' });
      rutas.add(p.ruta);
    });
    if (!rutas.has('')) ctx.addIssue({ code: 'custom', path: ['paginas'], message: 'missing_home_page' });
    const ids = new Set<string>();
    c.bloques.forEach((b, i) => {
      if (ids.has(b.id)) ctx.addIssue({ code: 'custom', path: ['bloques', i, 'id'], message: 'duplicate_block_id' });
      ids.add(b.id);
    });
    c.paginas.forEach((p, i) =>
      p.secciones.forEach((s, j) => {
        if (s.tipo === 'bloque' && !ids.has(s.id)) {
          ctx.addIssue({ code: 'custom', path: ['paginas', i, 'secciones', j, 'id'], message: 'unknown_block' });
        }
      }),
    );
    c.ejemplos.forEach((ruta, i) => {
      if (resolveContentPath(c, ruta) === undefined) {
        ctx.addIssue({ code: 'custom', path: ['ejemplos', i], message: 'unknown_example_path' });
      }
    });
  });
export type SiteContent = z.infer<typeof siteContentSchema>;

/**
 * El valor de texto al que apunta una ruta de ejemplo, o undefined si no
 * existe o no es texto. Las rutas de datos van por índice
 * ('precios.filas.2.precio'); las de bloques, por id y no por posición
 * ('bloques.historia.texto'), porque el cliente reordena bloques y una marca
 * por posición acabaría señalando el bloque equivocado.
 */
export function resolveContentPath(content: Pick<SiteContent, 'datos' | 'bloques'>, ruta: string): string | undefined {
  const parts = ruta.split('.');
  let value: unknown;
  if (parts[0] === 'bloques') {
    value = content.bloques.find((b) => b.id === parts[1]);
    parts.splice(0, 2);
  } else {
    value = content.datos;
  }
  for (const part of parts) {
    if (value == null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return typeof value === 'string' ? value : undefined;
}

/** La página de inicio de una web nueva: todas las secciones en el orden por
 *  defecto. Las que no tengan datos no se pintan (lo decide el motor). */
export function defaultHomePage(nombre = 'Inicio'): SitePage {
  return {
    ruta: '',
    titulo: nombre,
    metaTitulo: '',
    metaDescripcion: '',
    secciones: SITE_SECTION_TYPES.map((tipo) => ({ tipo })),
  };
}

export type SiteContentParseResult =
  | { ok: true; content: SiteContent }
  | { ok: false; issues: { path: string; message: string }[] };

/** Valida contenido que viene de fuera (la IA, el editor, una fila vieja). */
export function parseSiteContent(input: unknown): SiteContentParseResult {
  const parsed = siteContentSchema.safeParse(input);
  if (parsed.success) return { ok: true, content: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  };
}
