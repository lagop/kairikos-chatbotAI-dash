import { z } from 'zod';

// =============================================================================
// Cartera de Signature inmobiliaria — el formato propio, versión 1.
//
// Es el contrato entre el portal y la web. EL ESQUEMA VIVE EN LA PLANTILLA WEB
// (repositorio kairikos-signature-inmobiliaria, `src/content.config.ts` y
// `src/lib/media.ts`); esto es su copia. Si uno cambia el formato sin el otro,
// falla el test de contrato (tests/unit/cartera-feed-contract.test.ts aquí, y
// el suyo allí, con los JSON de la demo como ejemplos).
//
// Derivado el 19/11/2026 de content.config.ts en origin/main (8df8246): el
// `src/lib/cartera-feed.ts` de la web todavía no estaba publicado. Cuando lo
// esté, esta copia se sustituye por la suya tal cual.
//
// Lo que cambia respecto a las colecciones de la web (docs/fase1-cartera.md,
// «El formato propio»):
//   - Sin `level`, `plan` ni `reform`: el plano lo dibuja Kairikos a mano y
//     sigue en el repositorio de la web (src/content/escala/<ref>.json). Al
//     construir se une por la referencia.
//   - Con `photos: [{ url, width, height, alt: { es, en, de } }]`; la primera
//     es la portada.
//
// Y dos cosas que la web fija para su demo y aquí no pueden ser fijas, porque
// cada agencia tiene las suyas (anotadas para el lector del feed, PR 3):
//   - `agent`: la web lo tiene como enum de los tres agentes de la demo. Aquí
//     es una clave (`lucia`), que tiene que existir en CarteraSite.agents —
//     esa comprobación es de la aplicación (PR 2), no del formato.
//   - `ref`: la web exige C-/A- y tres cifras. Aquí el prefijo es el del sitio
//     (CarteraSite.salePrefix / rentPrefix, por defecto C y A) y se admiten
//     hasta cuatro cifras.
// =============================================================================

export const trSchema = z.object({ es: z.string(), en: z.string(), de: z.string() });
export type Tr = z.infer<typeof trSchema>;

const letter = z.enum(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
const isoDate = z.string().date();
const agentKey = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const refPattern = /^[A-Z]{1,3}-\d{3,4}$/;

const energySchema = z.object({ consumo: letter, kwh: z.number(), emisiones: letter, co2: z.number() });

// src/lib/media.ts de la web: recorrido Matterport o vídeo real, solo el
// identificador (nunca una URL ni HTML para incrustar).
export const mediaSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('matterport'), id: z.string().regex(/^[A-Za-z0-9]{11}$/, 'Matterport: el identificador del modelo tiene 11 letras y números (el valor de m= en el enlace).') }),
  z.object({ kind: z.literal('youtube'), id: z.string().regex(/^[A-Za-z0-9_-]{11}$/, 'YouTube: el identificador del vídeo tiene 11 caracteres (el valor de v= en el enlace).') }),
  z.object({ kind: z.literal('vimeo'), id: z.string().regex(/^\d{6,12}$/, 'Vimeo: el identificador del vídeo es el número del enlace.') }),
]);

export const photoSchema = z.object({
  url: z.string().url(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  alt: trSchema,
});
export type FeedPhoto = z.infer<typeof photoSchema>;

export const VENTA_STATUSES = ['proximamente', 'venta', 'reservada', 'vendida'] as const;
export const ALQUILER_STATUSES = ['disponible', 'reservada', 'alquilada'] as const;

/** Una casa en venta, tal como se guarda en CarteraHome.data (sin fotos). */
export const ventaDataObject = z.object({
  ref: z.string().regex(refPattern),
  // Fuera de mercado (fase 3). En la fase 1 siempre false.
  private: z.boolean().default(false),
  status: z.enum(VENTA_STATUSES),
  type: z.enum(['piso', 'atico', 'adosado', 'duplex', 'villa', 'casa', 'cortijo', 'parcela']),
  zone: z.enum(['costa', 'pueblo', 'golf', 'interior']),
  // Dirección de la ficha en cada idioma. No se llama «slug»: Astro usaría ese campo como identificador.
  slugs: trSchema,
  title: trSchema,
  summary: trSchema,
  price: z.number().int().positive(),
  listedAt: isoDate,
  // Cambios de precio reales, con fecha. Los apunta el portal; solo se enseñan si showHistory.
  priceHistory: z.array(z.object({ date: isoDate, price: z.number().int().positive() })).default([]),
  showHistory: z.boolean().default(false),
  usable: z.number().nonnegative(),
  built: z.number().nonnegative(),
  plot: z.number().positive().optional(),
  bedrooms: z.number().int().nonnegative(),
  bathrooms: z.number().int().nonnegative(),
  toilets: z.number().int().nonnegative().default(0),
  floor: trSchema.optional(),
  yearBuilt: z.number().int().optional(),
  yearRenovated: z.number().int().optional(),
  // Certificado energético: obligatorio para publicar (RD 390/2021, art. 15). Solo una parcela puede ir sin él.
  energy: energySchema.optional(),
  community: z.number().nonnegative().default(0),
  ibi: z.number().nonnegative(),
  // Basura y seguro al año; jardín y piscina al mes (0 si no hay).
  holding: z
    .object({ garbage: z.number().nonnegative(), insurance: z.number().nonnegative(), upkeep: z.number().nonnegative() })
    .default({ garbage: 0, insurance: 0, upkeep: 0 }),
  touristLicence: z.boolean().default(false),
  agent: agentKey,
  featured: z.boolean().default(false),
  tags: z.array(z.enum(['primera-linea', 'vistas-mar', 'piscina', 'sin-coche', 'para-reformar'])).default([]),
  // «Lo que no tiene»
  lacks: z.array(trSchema).default([]),
  media: z.array(mediaSchema).max(3).default([]),
});

/** Una vivienda en alquiler (LAU), tal como se guarda en CarteraHome.data. */
export const alquilerDataObject = z.object({
  ref: z.string().regex(refPattern),
  status: z.enum(ALQUILER_STATUSES),
  // «larga»: vivienda habitual (LAU art. 2). «temporada»: vivienda temporal (LAU art. 2.3), de 32 días a 12 meses.
  term: z.enum(['larga', 'temporada']),
  type: z.enum(['piso', 'atico', 'adosado', 'duplex', 'villa', 'casa', 'cortijo']),
  zone: z.enum(['costa', 'pueblo', 'golf', 'interior']),
  slugs: trSchema,
  title: trSchema,
  summary: trSchema,
  // Renta mensual en euros
  rent: z.number().int().positive(),
  listedAt: isoDate,
  availableFrom: isoDate,
  // Solo en temporada: estancia mínima y máxima en meses
  months: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
  furnished: z.boolean(),
  pets: z.boolean(),
  // Garantía adicional a la fianza, en mensualidades (LAU art. 36.5)
  guarantee: z.number().int().min(0).max(2).default(0),
  includes: z.array(z.enum(['comunidad', 'agua', 'luz', 'internet', 'limpieza', 'jardin', 'piscina'])).default([]),
  usable: z.number().positive(),
  built: z.number().positive(),
  plot: z.number().positive().optional(),
  bedrooms: z.number().int().positive(),
  bathrooms: z.number().int().positive(),
  toilets: z.number().int().nonnegative().default(0),
  floor: trSchema.optional(),
  yearBuilt: z.number().int().optional(),
  // El certificado energético también es obligatorio en todo anuncio de alquiler (RD 390/2021, art. 15)
  energy: energySchema,
  agent: agentKey,
  lacks: z.array(trSchema).default([]),
  media: z.array(mediaSchema).max(3).default([]),
});

type VentaShape = z.infer<typeof ventaDataObject>;
type AlquilerShape = z.infer<typeof alquilerDataObject>;

// Las reglas que no caben en el tipo de un campo, las mismas de la web.
function ventaRules(d: Pick<VentaShape, 'ref' | 'type' | 'energy'>, ctx: z.RefinementCtx) {
  if (d.type !== 'parcela' && !d.energy) {
    ctx.addIssue({ code: 'custom', message: `${d.ref}: falta el certificado energético. Sin él la casa no se puede publicar.`, path: ['energy'] });
  }
}

function alquilerRules(d: Pick<AlquilerShape, 'ref' | 'term' | 'months' | 'guarantee'>, ctx: z.RefinementCtx) {
  if (d.term === 'temporada' && !d.months) ctx.addIssue({ code: 'custom', message: `${d.ref}: un alquiler de temporada necesita su estancia mínima y máxima.`, path: ['months'] });
  if (d.term === 'larga' && d.months) ctx.addIssue({ code: 'custom', message: `${d.ref}: la larga duración no lleva meses: el contrato es de un año, prorrogable por ley.`, path: ['months'] });
  if (d.term === 'temporada' && d.guarantee > 1) ctx.addIssue({ code: 'custom', message: `${d.ref}: en vivienda temporal la garantía adicional es de una mensualidad como máximo (LAU art. 36.5).`, path: ['guarantee'] });
  if (d.months && d.months[1] > 12) ctx.addIssue({ code: 'custom', message: `${d.ref}: la vivienda temporal no pasa, por regla general, de doce meses (LAU art. 9 bis).`, path: ['months'] });
  if (d.months && d.months[0] > d.months[1]) ctx.addIssue({ code: 'custom', message: `${d.ref}: la estancia mínima supera la máxima.`, path: ['months'] });
}

/** Lo que se guarda en CarteraHome.data. */
export const ventaDataSchema = ventaDataObject.superRefine(ventaRules);
export const alquilerDataSchema = alquilerDataObject.superRefine(alquilerRules);

/** Una casa en el feed: su `data` más las fotos. */
export const ventaFeedSchema = ventaDataObject.extend({ photos: z.array(photoSchema) }).superRefine(ventaRules);
export const alquilerFeedSchema = alquilerDataObject.extend({ photos: z.array(photoSchema) }).superRefine(alquilerRules);

export type VentaFeedItem = z.infer<typeof ventaFeedSchema>;
export type AlquilerFeedItem = z.infer<typeof alquilerFeedSchema>;

export const FEED_VERSION = 1;

export const carteraFeedSchema = z.object({
  version: z.literal(FEED_VERSION),
  generatedAt: z.string().datetime(),
  ventas: z.array(ventaFeedSchema),
  alquileres: z.array(alquilerFeedSchema),
});
export type CarteraFeed = z.infer<typeof carteraFeedSchema>;

export type CarteraOperation = 'venta' | 'alquiler';
export const CARTERA_OPERATIONS: readonly CarteraOperation[] = ['venta', 'alquiler'];
