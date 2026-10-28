// =============================================================================
// La foto de portada de un oficio (28/10/2026).
//
// Hasta hoy todas las webs de oficios —borradores y publicadas— salían con la
// misma foto de banco (public/web-draft/trades.jpg). Con una plantilla en la
// que la foto manda, eso daba a todas las fontanerías y todos los
// electricistas la misma portada. Ahora hay tres fotos por oficio en
// public/web-draft/oficios/ y cada negocio se queda con una.
//
// Qué oficios: los que de verdad aparecen entre los prospectos de producción
// (28/10), no una lista de manual. La carpintería de aluminio es con mucho la
// más frecuente (más de 40), y Google la clasifica como 'manufacturer', que
// no dice nada. Por eso se mira PRIMERO el nombre del negocio («Aluminios
// Marrero», «Reformas Atlántico», «Yuba Solar») y solo después el tipo de
// Google. Jardinería y climatización no salían y se dejaron fuera.
//
// Sin IA y sin coste: es una regla. Y estable: el mismo nombre da siempre la
// misma foto, así que el borrador y la web publicada coinciden y tres
// fontanerías de la misma zona no salen con la misma.
//
// Solo para la familia de oficios: una peluquería que se llame «Solar» no
// tiene que salir con placas solares.
// =============================================================================

/** Cuántas fotos hay de cada oficio. Una prueba comprueba que están todas en
 *  public/web-draft/oficios/ (<oficio>-<n>.jpg). */
export const TRADE_PHOTO_COUNTS = Object.freeze({
  aluminio: 3,
  solar: 3,
  fontaneria: 3,
  electricidad: 3,
  cerrajeria: 3,
  carpinteria: 3,
  taller: 3,
  pintura: 3,
  reformas: 3,
} as const);

export type TradePhotoSet = keyof typeof TRADE_PHOTO_COUNTS;

/** Por el nombre, en este orden: el primero que encaje gana. El orden
 *  importa: «Carpintería de Aluminio» es aluminio y no madera, «Talleres
 *  Camacho Carpintería de Aluminio» tampoco es un taller mecánico, y «chapa y
 *  pintura» es un taller y no un pintor. */
const BY_NAME: readonly [TradePhotoSet, RegExp][] = [
  ['aluminio', /alumin|cristaler|\bpvc\b|carpinteria metalica|metalicas?\b/],
  ['solar', /solar|fotovolt|renovable|autoconsumo/],
  ['fontaneria', /fontaner|desatasc|plumb|saneamiento/],
  ['electricidad', /electric|electro/],
  ['cerrajeria', /cerraj|locksmith/],
  ['carpinteria', /carpinter|ebanist|madera/],
  ['taller', /taller|mecanic|chapa y pintura|neumatic/],
  ['pintura', /pintor|pintura/],
  ['reformas', /reforma|construcc|\bobras?\b|albanil|escayol|rehabilit/],
];

/** Si el nombre no dice nada, el tipo de Google. Los que no están aquí
 *  ('manufacturer', 'service'…) se quedan con la foto genérica. */
const BY_PRIMARY_TYPE: Readonly<Record<string, TradePhotoSet>> = Object.freeze({
  plumber: 'fontaneria',
  electrician: 'electricidad',
  locksmith: 'cerrajeria',
  general_contractor: 'reformas',
  roofing_contractor: 'reformas',
  painter: 'pintura',
  car_repair: 'taller',
});

function normalize(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** El oficio de la foto, o null si no se sabe. */
export function tradePhotoSet(businessName: string, primaryType: string | null): TradePhotoSet | null {
  const name = normalize(businessName);
  for (const [set, pattern] of BY_NAME) if (pattern.test(name)) return set;
  return primaryType ? (BY_PRIMARY_TYPE[primaryType] ?? null) : null;
}

/** Un número estable a partir del nombre (FNV-1a): el mismo negocio, la
 *  misma foto, hoy y cuando publique. */
function stableIndex(text: string, size: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % size;
}

/**
 * La ruta pública de la foto ('/web-draft/oficios/aluminio-2.jpg'), o null:
 * otra familia que no sea oficios, o un oficio que no se reconoce. Con null,
 * quien llama usa la foto del sector de siempre.
 */
export function tradeHeroPhoto(family: string, businessName: string, primaryType: string | null): string | null {
  if (family !== 'trades') return null;
  const set = tradePhotoSet(businessName, primaryType);
  if (!set) return null;
  const n = stableIndex(normalize(businessName).trim(), TRADE_PHOTO_COUNTS[set]) + 1;
  return `/web-draft/oficios/${set}-${n}.jpg`;
}
