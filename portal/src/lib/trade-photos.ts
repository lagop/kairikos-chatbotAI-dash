// =============================================================================
// La foto de portada de un oficio (28/10/2026).
//
// Hasta hoy todas las webs de oficios —borradores y publicadas— salían con la
// misma foto de banco (public/web-draft/trades.jpg). Con una plantilla en la
// que la foto manda, eso daba a todas las fontanerías y todos los
// electricistas la misma portada. Ahora hay tres fotos de portada por oficio
// en public/web-draft/oficios/ y cada negocio se queda con una (y cinco más
// para las pestañas del borrador; ver TRADE_HERO_PHOTOS).
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
  aluminio: 8,
  solar: 8,
  fontaneria: 8,
  electricidad: 8,
  cerrajeria: 8,
  carpinteria: 8,
  taller: 8,
  pintura: 8,
  reformas: 8,
} as const);

/** Las de portada son las 3 primeras de cada oficio; las demás (4..8, del
 *  28/10/2026) van en las pestañas de «Qué incluye cada servicio». Separadas
 *  a propósito: si la portada eligiera entre las 8, el índice estable
 *  cambiaría y un prospecto que ya vio su borrador lo encontraría con otra
 *  foto. Y así una pestaña nunca repite la foto de portada. */
export const TRADE_HERO_PHOTOS = 3;

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
 * (belleza y salud tienen la suya, abajo)
 * otra familia que no sea oficios, o un oficio que no se reconoce. Con null,
 * quien llama usa la foto del sector de siempre.
 */
export function tradeHeroPhoto(family: string, businessName: string, primaryType: string | null): string | null {
  if (family === 'beauty') return beautyHeroPhoto(businessName, primaryType);
  if (family === 'health') return healthHeroPhoto(businessName, primaryType);
  if (family !== 'trades') return null;
  const set = tradePhotoSet(businessName, primaryType);
  if (!set) return null;
  const n = stableIndex(normalize(businessName).trim(), TRADE_HERO_PHOTOS) + 1;
  return `/web-draft/oficios/${set}-${n}.jpg`;
}

/** Las fotos de oficio que no son de portada, empezando en un punto estable
 *  según el nombre: dos aluminios de la misma zona no salen con las pestañas
 *  en el mismo orden. */
export function tradeDetailPhotos(set: TradePhotoSet, businessName: string): string[] {
  const all = Array.from({ length: TRADE_PHOTO_COUNTS[set] - TRADE_HERO_PHOTOS }, (_, i) => `/web-draft/oficios/${set}-${TRADE_HERO_PHOTOS + i + 1}.jpg`);
  const start = stableIndex(normalize(businessName).trim(), all.length);
  return [...all.slice(start), ...all.slice(0, start)];
}

// -----------------------------------------------------------------------------
// Belleza (28/10/2026). Los 16 prospectos del sector eran peluquerías, alguna
// también barbería; estética y uñas no salían. Las fotos están en
// public/web-draft/belleza/ junto con las de la galería de ejemplo
// (site-sector-blocks.ts), que no se usan de portada.
// -----------------------------------------------------------------------------

export const BEAUTY_PHOTO_COUNTS = Object.freeze({ peluqueria: 3, barberia: 2 } as const);
export type BeautyPhotoSet = keyof typeof BEAUTY_PHOTO_COUNTS;

/** Barbería si lo dice el nombre o Google; si no, peluquería, que en el sector
 *  es casi todo (y una peluquería que también corta a hombres se ve bien con
 *  la foto de peluquería). */
export function beautyPhotoSet(businessName: string, primaryType: string | null): BeautyPhotoSet {
  return /barber/.test(normalize(businessName)) || primaryType === 'barber_shop' ? 'barberia' : 'peluqueria';
}

function beautyHeroPhoto(businessName: string, primaryType: string | null): string | null {
  // Estética, uñas y spa también son de la familia belleza, pero una foto de
  // peluquería les quedaría falsa: para ellos, la del sector de siempre.
  if (primaryType && !['hair_salon', 'barber_shop'].includes(primaryType) && !/pelu|barber|hair|estilis/.test(normalize(businessName))) return null;
  const set = beautyPhotoSet(businessName, primaryType);
  const n = stableIndex(normalize(businessName).trim(), BEAUTY_PHOTO_COUNTS[set]) + 1;
  return `/web-draft/belleza/${set}-${n}.jpg`;
}

// -----------------------------------------------------------------------------
// Salud (30/10/2026). Ningún prospecto del sector todavía: las fotos se
// eligieron por lo que Google mete en la familia (dentist, dental_clinic,
// physiotherapist, veterinary_care, doctor). Están en public/web-draft/salud/.
// A diferencia de oficios y belleza, aquí sí salen personas: una consulta sin
// nadie parece cerrada, y son modelos de banco, no el personal de la clínica.
// Lo que no se reconoce sale con la de consulta genérica (clinica-*), no con
// health.jpg: en salud todas las fotos sirven para cualquiera del sector.
// -----------------------------------------------------------------------------

export const HEALTH_PHOTO_COUNTS = Object.freeze({ dental: 5, fisioterapia: 5, veterinaria: 5, clinica: 4 } as const);
export type HealthPhotoSet = keyof typeof HEALTH_PHOTO_COUNTS;

/** Veterinaria primero: «Clínica Dental Veterinaria» no existe, pero
 *  «Hospital Veterinario San Bernardo» no es una consulta médica. */
const HEALTH_BY_NAME: readonly [HealthPhotoSet, RegExp][] = [
  ['veterinaria', /veterin|mascota|animal|canin|felin/],
  ['dental', /dent|odonto|ortodon|sonrisa|implant/],
  ['fisioterapia', /fisio|osteopat|quiropr|rehabilit|physio/],
];

const HEALTH_BY_PRIMARY_TYPE: Readonly<Record<string, HealthPhotoSet>> = Object.freeze({
  dentist: 'dental',
  dental_clinic: 'dental',
  physiotherapist: 'fisioterapia',
  veterinary_care: 'veterinaria',
  doctor: 'clinica',
});

export function healthPhotoSet(businessName: string, primaryType: string | null): HealthPhotoSet {
  const name = normalize(businessName);
  for (const [set, pattern] of HEALTH_BY_NAME) if (pattern.test(name)) return set;
  return (primaryType && HEALTH_BY_PRIMARY_TYPE[primaryType]) || 'clinica';
}

function healthHeroPhoto(businessName: string, primaryType: string | null): string {
  const set = healthPhotoSet(businessName, primaryType);
  const n = stableIndex(normalize(businessName).trim(), HEALTH_PHOTO_COUNTS[set]) + 1;
  return `/web-draft/salud/${set}-${n}.jpg`;
}
