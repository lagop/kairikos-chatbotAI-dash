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

export function normalize(name: string): string {
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
 * (belleza, salud, restauración y profesionales tienen la suya, abajo)
 * otra familia que no sea oficios, o un oficio que no se reconoce. Con null,
 * quien llama usa la foto del sector de siempre.
 */
export function tradeHeroPhoto(family: string, businessName: string, primaryType: string | null): string | null {
  if (family === 'beauty') return beautyHeroPhoto(businessName, primaryType);
  if (family === 'health') return healthHeroPhoto(businessName, primaryType);
  if (family === 'food') return foodHeroPhoto(businessName, primaryType);
  if (family === 'professional') return professionalHeroPhoto(businessName, primaryType);
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
//
// 31/10/2026 — también uñas, estética y spa, que hasta entonces salían con la
// genérica (beauty.jpg) porque una foto de pelo les quedaba falsa. La casilla
// «Estética» del formulario de kairikos.com (beauty_salon) caía ahí entera.
// Mismo criterio que las de pelo: manos, producto y local, sin caras.
// -----------------------------------------------------------------------------

export const BEAUTY_PHOTO_COUNTS = Object.freeze({ peluqueria: 3, barberia: 2, unas: 4, estetica: 3, spa: 3 } as const);
export type BeautyPhotoSet = keyof typeof BEAUTY_PHOTO_COUNTS;

/** El nombre manda sobre Google, como en oficios: «Barbería Toni» puede estar
 *  dada de alta como hair_salon. Barbería antes que peluquería, porque
 *  «Peluquería y Barbería» se ve mejor con la de barbería; uñas y spa antes
 *  que estética, que es la palabra más genérica de las tres. «Belleza» no
 *  cuenta: lo usan peluquerías y centros de estética por igual, y ahí decide
 *  el tipo de Google. */
const BEAUTY_BY_NAME: readonly [BeautyPhotoSet, RegExp][] = [
  ['barberia', /barber/],
  ['unas', /\bunas?\b|nail|manicur|pedicur/],
  ['spa', /\bspa\b|masaj|wellness|balneari|termal|hammam|\bzen\b/],
  ['peluqueria', /pelu|hair|estilis/],
  ['estetica', /estetic|facial|depila|cosmet/],
];

const BEAUTY_BY_PRIMARY_TYPE: Readonly<Record<string, BeautyPhotoSet>> = Object.freeze({
  barber_shop: 'barberia',
  hair_salon: 'peluqueria',
  nail_salon: 'unas',
  spa: 'spa',
  beauty_salon: 'estetica',
});

/** Sin nombre que lo diga ni tipo conocido, peluquería, que en el sector es
 *  casi todo. */
export function beautyPhotoSet(businessName: string, primaryType: string | null): BeautyPhotoSet {
  const name = normalize(businessName);
  for (const [set, pattern] of BEAUTY_BY_NAME) if (pattern.test(name)) return set;
  return (primaryType && BEAUTY_BY_PRIMARY_TYPE[primaryType]) || 'peluqueria';
}

/** Las de pelo: solo a esas les valen los bloques de ejemplo de
 *  site-sector-blocks.ts (galería de cortes, antes y después de color). */
export function isHairPhotoSet(set: BeautyPhotoSet): set is 'peluqueria' | 'barberia' {
  return set === 'peluqueria' || set === 'barberia';
}

function beautyHeroPhoto(businessName: string, primaryType: string | null): string {
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

// -----------------------------------------------------------------------------
// Restauración y profesionales (31/10/2026), para las primeras plantillas de
// los dos sectores. Hasta ese día salían con food.jpg y professional.jpg, una
// para todos, y kairikos.com ya ofrecía «Restaurante o bar» y «Asesoría o
// despacho». Ningún borrador de producción era de estas familias, así que
// ninguno cambia de foto. Como en salud, lo que no se reconoce sale con la del
// grueso del sector (restaurante, despacho) y no con la genérica.
//
// Menos fotos que en otros sectores: de las quince que se bajaron se
// descartaron tres (un logo en las copas, una caja de una marca de agendas y
// un vaso de una cadena de cafés, y una pared de cuadros con gente). Con dos
// por grupo, dos cafeterías vecinas pueden coincidir: se acepta mientras no
// haya prospectos del sector que pidan más. Ver public/web-draft/README.md.
// -----------------------------------------------------------------------------

export const FOOD_PHOTO_COUNTS = Object.freeze({ restaurante: 3, cafeteria: 2, panaderia: 2 } as const);
export type FoodPhotoSet = keyof typeof FOOD_PHOTO_COUNTS;

/** Panadería antes que cafetería: «Panadería Cafetería La Espiga» vende pan.
 *  «Horno» no cuenta: también lo dice «Pizzería Horno de Leña». */
const FOOD_BY_NAME: readonly [FoodPhotoSet, RegExp][] = [
  ['panaderia', /panader|pasteler|bakery|obrador|reposter|bolleri|dulceri|confiter/],
  ['cafeteria', /cafe|coffee|churrer/],
];

const FOOD_BY_PRIMARY_TYPE: Readonly<Record<string, FoodPhotoSet>> = Object.freeze({
  bakery: 'panaderia',
  cafe: 'cafeteria',
  coffee_shop: 'cafeteria',
});

export function foodPhotoSet(businessName: string, primaryType: string | null): FoodPhotoSet {
  const name = normalize(businessName);
  for (const [set, pattern] of FOOD_BY_NAME) if (pattern.test(name)) return set;
  return (primaryType && FOOD_BY_PRIMARY_TYPE[primaryType]) || 'restaurante';
}

export const PROFESSIONAL_PHOTO_COUNTS = Object.freeze({ despacho: 2, inmobiliaria: 3 } as const);
export type ProfessionalPhotoSet = keyof typeof PROFESSIONAL_PHOTO_COUNTS;

/** Asesorías, abogados y seguros comparten despacho; las inmobiliarias (y las
 *  administraciones de fincas, que viven de llaves y pisos) van aparte. */
export function professionalPhotoSet(businessName: string, primaryType: string | null): ProfessionalPhotoSet {
  return /inmobiliar|real estate|realty|fincas|propiedades|viviendas/.test(normalize(businessName)) || primaryType === 'real_estate_agency'
    ? 'inmobiliaria'
    : 'despacho';
}

function foodHeroPhoto(businessName: string, primaryType: string | null): string {
  const set = foodPhotoSet(businessName, primaryType);
  const n = stableIndex(normalize(businessName).trim(), FOOD_PHOTO_COUNTS[set]) + 1;
  return `/web-draft/restauracion/${set}-${n}.jpg`;
}

function professionalHeroPhoto(businessName: string, primaryType: string | null): string {
  const set = professionalPhotoSet(businessName, primaryType);
  const n = stableIndex(normalize(businessName).trim(), PROFESSIONAL_PHOTO_COUNTS[set]) + 1;
  return `/web-draft/profesionales/${set}-${n}.jpg`;
}
