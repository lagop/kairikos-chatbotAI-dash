// =============================================================================
// COPIA del formato propio de la cartera, versión 1. NO SE EDITA AQUÍ.
//
// Origen: kairikos-signature-inmobiliaria, origin/main 50c3e0f (su PR 1):
//   - src/lib/cartera-feed.ts, entero, cambiando solo `import { z } from 'astro/zod'`
//     por 'zod';
//   - mediaSchema de src/lib/media.ts (allí importa de 'astro:content'), que aquí va
//     dentro del mismo archivo en vez de `import { mediaSchema } from './media'`.
// Si el formato cambia, se cambia en la plantilla y se vuelve a copiar; el test de
// contrato (tests/unit/cartera-feed-contract.test.ts) usa el mismo ejemplo que el
// suyo, tests/fixtures/cartera-feed.json, copiado en tests/fixtures/cartera/.
//
// Agentes y prefijos (20/11/2026): hasta esta copia, `agent` era el enum de la demo
// (lucia, elena, daniel) y `ref` exigía C-/P-/A-, así que el feed de cualquier otra
// agencia no validaba. Ahora el formato solo fija la forma: la clave de agente de
// CarteraSite.agents y el prefijo de salePrefix/rentPrefix (de una a tres
// mayúsculas) con tres cifras. Que el agente exista lo comprueban los dos lados por
// su cuenta: el portal contra CarteraSite.agents (validateHome) y la web contra su
// src/config/agents.ts (su lector para el build si no está).
// =============================================================================

// Formato propio de la cartera, versión 1 (docs/fase1-cartera.md, «El formato propio»).
// Es el contrato entre el portal de Kairikos y esta web: el portal genera el feed y la web lo valida al construir.
// El portal lleva una copia de este archivo (lib/cartera/schema.ts en kairikos_dashboard) cambiando solo los imports;
// el test de contrato de los dos repositorios valida tests/fixtures/cartera-feed.json. Si cambia aquí, cambia allí.
//
// Una casa del feed es lo que escribe la agencia: sin el plano. `level`, `plan` y `reform` los dibuja Kairikos y viven en
// src/content/escala/<ref>.json; al construir se unen por la referencia (src/lib/cartera-loader.ts).
import { z } from 'zod';

// Recorrido o vídeo real de una casa, alojado en un proveedor externo (Matterport, YouTube o Vimeo).
// En la ficha solo se guarda el identificador, nunca una URL ni un código para incrustar: la dirección la monta la web,
// así no se cuela otro dominio ni HTML. Se carga al pulsar (RealMedia.astro); hasta entonces no se pide nada al proveedor.
export const mediaSchema = z.discriminatedUnion('kind', [
  // https://my.matterport.com/show/?m=<id>
  z.object({ kind: z.literal('matterport'), id: z.string().regex(/^[A-Za-z0-9]{11}$/, 'Matterport: el identificador del modelo tiene 11 letras y números (el valor de m= en el enlace).') }),
  // https://www.youtube.com/watch?v=<id>
  z.object({ kind: z.literal('youtube'), id: z.string().regex(/^[A-Za-z0-9_-]{11}$/, 'YouTube: el identificador del vídeo tiene 11 caracteres (el valor de v= en el enlace).') }),
  // https://vimeo.com/<id>
  z.object({ kind: z.literal('vimeo'), id: z.string().regex(/^\d{6,12}$/, 'Vimeo: el identificador del vídeo es el número del enlace.') }),
]);
export type Media = z.infer<typeof mediaSchema>;

const t = z.object({ es: z.string(), en: z.string(), de: z.string() });
const letter = z.enum(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
const energy = z.object({ consumo: letter, kwh: z.number(), emisiones: letter, co2: z.number() });
// Agente: la clave de src/config/agents.ts de la web de cada agencia (en la demo, lucia, elena y daniel). El formato solo
// fija su forma, la misma que acepta el portal (CarteraSite.agents); que exista en ESTA web lo comprueba el lector
// (src/lib/cartera-loader.ts) y la colección la estrecha a sus agentes (src/content.config.ts). Hasta el 20/11/2026 era
// el enum de la demo, y el feed de cualquier otra agencia no validaba.
const agent = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'la clave del agente va en minúsculas, números y guiones (la de src/config/agents.ts)');
// Referencia: el prefijo de la agencia (de una a tres mayúsculas; en la demo, C y P en venta y A en alquiler) y tres cifras.
// Venta y alquiler van en listas separadas del feed: el prefijo no dice la operación. Que una referencia no se repita entre
// las dos lo comprueba el lector, porque el plano se une por ella.
export const REF = /^[A-Z]{1,3}-\d{3}$/;
const ref = z.string().regex(REF, 'la referencia es el prefijo de la agencia (de una a tres mayúsculas), un guion y tres cifras');
const zone = z.enum(['costa', 'pueblo', 'golf', 'interior']);

// Fotos: las sirve el portal (decisión A, volumen de la VPS) y la web las descarga al construir. La primera es la portada.
// Sin EXIF ni GPS: el portal las vuelve a codificar al subirlas.
// http solo en la máquina local: el test de contrato sirve ahí su foto de ejemplo (scripts/contrato-cartera.mjs).
// En una web que sigue sin el portal, la foto es un archivo de src/content/fotos/: así la deja la exportación de la
// cartera (docs/exportacion.md). El feed del portal nunca las manda así.
export const LOCAL_PHOTO = /^fotos\/[a-z]{1,3}-\d{2,4}\/[a-z0-9_-]+\.(jpe?g|png|webp)$/;
const remote = (u: string) => (u.startsWith('https://') || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u)) && URL.canParse(u);
export const photoSchema = z.object({
  url: z
    .string()
    .refine((u) => LOCAL_PHOTO.test(u) || remote(u), 'la foto tiene que ir por https o ser un archivo de src/content/fotos/ (fotos/<ref>/<archivo>.jpg)'),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  alt: t.partial().default({}),
});

// --- Plano a escala (solo en src/content/escala/, nunca en el feed) ---
// Cada planta es un rectángulo dividido en franjas (rows) de fachada a fachada; cada franja, en estancias de izquierda a
// derecha. Una celda puede ser una pila de estancias (stack) de arriba abajo. Estancia: [tipo, medida en metros, número
// opcional]. El norte está arriba.
const room = z.union([z.tuple([z.string(), z.number()]), z.tuple([z.string(), z.number(), z.number()])]);
const cell = z.union([room, z.object({ w: z.number(), stack: z.array(room) })]);
const floor = z.object({
  name: z.enum(['unica', 'baja', 'primera', 'semisotano', 'parcela']),
  width: z.number(),
  rows: z.array(z.object({ h: z.number(), cells: z.array(cell) })),
  // Lados que son medianera (pared compartida con el vecino): no cuentan como fachada al decir a dónde da una estancia
  party: z.array(z.enum(['N', 'S', 'E', 'W'])).default([]),
  // Franja exterior al sur (terraza, porche, patio): se dibuja a trazos y no cuenta en los metros útiles
  outdoor: z.object({ kind: z.enum(['terraza', 'porche', 'patio']), depth: z.number() }).optional(),
});
export const planSchema = z.object({ floors: z.array(floor).min(1) });
// «Si la reformas»: horquilla de coste por partidas [mínimo, máximo] y una frase de contexto. Solo venta
const reformSchema = z.object({ note: t, items: z.array(z.object({ name: t, cost: z.tuple([z.number().int().positive(), z.number().int().positive()]) })).min(1) });

/** src/content/escala/<ref>.json: lo que hace «a escala» una ficha. Lo prepara Kairikos, no la agencia. */
export const escalaSchema = z.object({ plan: planSchema, reform: reformSchema.optional() }).strict();
export type Escala = z.infer<typeof escalaSchema>;

// --- Venta ---
const venta = z.object({
  // En la demo, C- es la cartera pública y P- la que está fuera de mercado; lo que la saca del mercado es `private`.
  ref,
  // Fuera de mercado: no entra en /comprar, ni en comparar, ni tiene ficha pública. En la demo solo se ve en /privado.
  private: z.boolean().default(false),
  status: z.enum(['proximamente', 'venta', 'reservada', 'vendida']),
  type: z.enum(['piso', 'atico', 'adosado', 'duplex', 'villa', 'casa', 'cortijo', 'parcela']),
  zone,
  // Dirección de la ficha en cada idioma. No se llama «slug»: Astro usaría ese campo como identificador.
  slugs: t,
  title: t,
  summary: t,
  price: z.number().int().positive(),
  listedAt: z.string().date(),
  // Cambios de precio reales, con fecha (los apunta el portal). Solo se enseñan si showHistory (lo decide la agencia con el vendedor).
  priceHistory: z.array(z.object({ date: z.string().date(), price: z.number().int().positive() })).default([]),
  showHistory: z.boolean().default(false),
  usable: z.number().nonnegative(),
  built: z.number().nonnegative(),
  plot: z.number().positive().optional(),
  bedrooms: z.number().int().nonnegative(),
  bathrooms: z.number().int().nonnegative(),
  toilets: z.number().int().nonnegative().default(0),
  floor: t.optional(),
  yearBuilt: z.number().int().optional(),
  yearRenovated: z.number().int().optional(),
  // Certificado energético: obligatorio para publicar (RD 390/2021, art. 15). Solo una parcela puede ir sin él.
  energy: energy.optional(),
  community: z.number().nonnegative().default(0),
  ibi: z.number().nonnegative(),
  // «Lo que cuesta tenerla»: basura y seguro al año; jardín y piscina al mes (0 si no hay)
  holding: z.object({ garbage: z.number().nonnegative(), insurance: z.number().nonnegative(), upkeep: z.number().nonnegative() }).default({ garbage: 0, insurance: 0, upkeep: 0 }),
  touristLicence: z.boolean().default(false),
  agent,
  featured: z.boolean().default(false),
  // Características que no salen de otros campos y definen las colecciones (src/config/collections.ts)
  tags: z.array(z.enum(['primera-linea', 'vistas-mar', 'piscina', 'sin-coche', 'para-reformar'])).default([]),
  // «Lo que no tiene»: opcional por inmueble
  lacks: z.array(t).default([]),
  // Recorrido Matterport o vídeo real de la casa (YouTube, Vimeo): solo el identificador. Hasta tres; se cargan al pulsar
  media: z.array(mediaSchema).max(3).default([]),
  photos: z.array(photoSchema).max(40).default([]),
});

const ventaRules = (d: z.infer<typeof venta>, ctx: z.RefinementCtx) => {
  if (d.type !== 'parcela' && !d.energy) {
    ctx.addIssue({ code: 'custom', message: `${d.ref}: falta el certificado energético. Sin él la casa no se puede publicar.`, path: ['energy'] });
  }
};

// --- Alquiler ---
// Colección aparte de la venta: otra ley (LAU), otro cliente y otras cifras; comparte el plano en datos y su geometría.
const alquiler = z.object({
  ref,
  status: z.enum(['disponible', 'reservada', 'alquilada']),
  // «larga»: vivienda habitual (LAU art. 2), contrato de un año prorrogable hasta cinco por ley.
  // «temporada»: vivienda temporal (LAU art. 2.3, tras el RDL 29/2026): quien está fuera de su vivienda habitual por
  // una causa que consta en el contrato (trabajo, estudios…), de 32 días a 12 meses. Nunca turístico.
  term: z.enum(['larga', 'temporada']),
  type: z.enum(['piso', 'atico', 'adosado', 'duplex', 'villa', 'casa', 'cortijo']),
  zone,
  slugs: t,
  title: t,
  summary: t,
  // Renta mensual en euros
  rent: z.number().int().positive(),
  listedAt: z.string().date(),
  availableFrom: z.string().date(),
  // Solo en temporada: estancia mínima y máxima en meses
  months: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
  furnished: z.boolean(),
  pets: z.boolean(),
  // Garantía adicional a la fianza, en mensualidades: como máximo dos en larga duración y una en temporada (LAU art. 36.5)
  guarantee: z.number().int().min(0).max(2).default(0),
  // Lo que va incluido en la renta
  includes: z.array(z.enum(['comunidad', 'agua', 'luz', 'internet', 'limpieza', 'jardin', 'piscina'])).default([]),
  usable: z.number().positive(),
  built: z.number().positive(),
  plot: z.number().positive().optional(),
  bedrooms: z.number().int().positive(),
  bathrooms: z.number().int().positive(),
  toilets: z.number().int().nonnegative().default(0),
  floor: t.optional(),
  yearBuilt: z.number().int().optional(),
  // El certificado energético también es obligatorio en todo anuncio de alquiler (RD 390/2021, art. 15)
  energy,
  agent,
  lacks: z.array(t).default([]),
  media: z.array(mediaSchema).max(3).default([]),
  photos: z.array(photoSchema).max(40).default([]),
});

const alquilerRules = (d: z.infer<typeof alquiler>, ctx: z.RefinementCtx) => {
  if (d.term === 'temporada' && !d.months) ctx.addIssue({ code: 'custom', message: `${d.ref}: un alquiler de temporada necesita su estancia mínima y máxima.`, path: ['months'] });
  if (d.term === 'larga' && d.months) ctx.addIssue({ code: 'custom', message: `${d.ref}: la larga duración no lleva meses: el contrato es de un año, prorrogable por ley.`, path: ['months'] });
  if (d.term === 'temporada' && d.guarantee > 1) ctx.addIssue({ code: 'custom', message: `${d.ref}: en vivienda temporal la garantía adicional es de una mensualidad como máximo (LAU art. 36.5).`, path: ['guarantee'] });
  if (d.months && d.months[1] > 12) ctx.addIssue({ code: 'custom', message: `${d.ref}: la vivienda temporal no pasa, por regla general, de doce meses (LAU art. 9 bis).`, path: ['months'] });
  if (d.months && d.months[0] > d.months[1]) ctx.addIssue({ code: 'custom', message: `${d.ref}: la estancia mínima supera la máxima.`, path: ['months'] });
};

// --- Lo que manda el portal ---
/** Una casa en venta tal como llega en el feed (sin plano). */
export const ventaFeedSchema = venta.strict().superRefine(ventaRules);
/** Una vivienda en alquiler tal como llega en el feed (sin plano). */
export const alquilerFeedSchema = alquiler.strict().superRefine(alquilerRules);

/** El feed entero. Las casas se validan una a una al construir, para que el error diga qué referencia falla. */
export const feedSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().datetime(),
  ventas: z.array(z.record(z.unknown())),
  alquileres: z.array(z.record(z.unknown())),
});
export type Feed = z.infer<typeof feedSchema>;

// --- Lo que usa la web: la casa del feed más su archivo de escala, si lo tiene ---
// «escala»: ficha completa con plano y cotas. «estandar»: la que entra sola desde la cartera.
const level = z.enum(['escala', 'estandar']);
const levelRule = (d: { ref: string; level: string; plan?: unknown }, ctx: z.RefinementCtx) => {
  if (d.level === 'escala' && !d.plan) ctx.addIssue({ code: 'custom', message: `${d.ref}: una ficha a escala necesita plano.`, path: ['plan'] });
};

export const ventaSchema = venta.extend({ level, plan: planSchema.optional(), reform: reformSchema.optional() }).superRefine((d, ctx) => {
  ventaRules(d, ctx);
  levelRule(d, ctx);
});
export const alquilerSchema = alquiler.extend({ level, plan: planSchema.optional() }).superRefine((d, ctx) => {
  alquilerRules(d, ctx);
  levelRule(d, ctx);
});
