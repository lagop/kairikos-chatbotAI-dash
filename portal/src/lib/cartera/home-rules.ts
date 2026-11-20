import { alquilerFeedSchema, ventaFeedSchema } from './schema';
import type { CarteraOperation } from './types';

// =============================================================================
// Cartera — las reglas de una casa al guardarla (docs/fase1-cartera.md,
// «Panel /portal/cartera», «Reglas»). Puras, sin base de datos: las usan las
// rutas del panel (lib/cartera/homes.ts) y sus tests.
//
//   - La referencia se asigna sola (C-1xx venta, A-2xx alquiler) y no cambia.
//   - Las direcciones de la ficha (`slugs`) salen del título al guardar y se
//     congelan al publicarse por primera vez: cambiarlas rompería enlaces.
//   - Se guarda siempre, aunque falten datos; lo que no valida queda en
//     `errors` y la casa no se publica hasta corregirlo. Las reglas son las de
//     la web: se valida contra la copia de su esquema (schema.ts).
//   - Cada cambio de precio de una casa ya publicada se apunta solo en
//     `priceHistory`; la agente decide con `showHistory` si se enseña.
//   - Una casa publicada no vuelve a borrador ni se borra: se retira con su
//     estado (vendida, alquilada). Solo se borra un borrador.
// =============================================================================

export type { CarteraOperation };

const ventaObject = ventaFeedSchema.innerType();
const alquilerObject = alquilerFeedSchema.innerType();

/** Lo que pone el portal y no la agente: nunca se acepta del cuerpo. */
const SERVER_KEYS = new Set(['ref', 'status', 'photos', 'slugs', 'priceHistory', 'private']);

export const EDITABLE_KEYS: Record<CarteraOperation, readonly string[]> = {
  venta: Object.keys(ventaObject.shape).filter((k) => !SERVER_KEYS.has(k)),
  alquiler: Object.keys(alquilerObject.shape).filter((k) => !SERVER_KEYS.has(k)),
};

export const HOME_STATUSES: Record<CarteraOperation, readonly string[]> = {
  venta: ['borrador', ...ventaObject.shape.status.options],
  alquiler: ['borrador', ...alquilerObject.shape.status.options],
};

export const STATUS_LABELS: Record<string, string> = {
  borrador: 'Borrador',
  proximamente: 'Próximamente',
  venta: 'En venta',
  reservada: 'Reservada',
  vendida: 'Vendida',
  disponible: 'Disponible',
  alquilada: 'Alquilada',
};

/** Tope del JSON de una casa: una ficha real ocupa 3–6 KB. */
export const MAX_HOME_DATA_CHARS = 60_000;

// --- Referencia ---------------------------------------------------------------

/** Primera referencia de cada operación: C-101, A-201 (como la demo). */
const REF_BASE: Record<CarteraOperation, number> = { venta: 101, alquiler: 201 };

/**
 * La siguiente referencia libre: la más alta con ese prefijo más uno, nunca
 * por debajo de la base. Tres cifras, que es lo que admite la web. Null si ya
 * no caben (C-999): no pasa con carteras reales, pero no se inventa un formato.
 */
export function nextRef(existing: readonly string[], prefix: string, operation: CarteraOperation): string | null {
  const re = new RegExp(`^${prefix}-(\\d{3,4})$`);
  let max = REF_BASE[operation] - 1;
  for (const ref of existing) {
    const m = re.exec(ref);
    if (m) max = Math.max(max, Number(m[1]));
  }
  const next = max + 1;
  if (next > 999) return null;
  return `${prefix}-${String(next).padStart(3, '0')}`;
}

// --- Direcciones de la ficha --------------------------------------------------

const GERMAN: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'ae', Ö: 'oe', Ü: 'ue', ß: 'ss' };

/** «Wohnung mit Südterrasse» → «wohnung-mit-suedterrasse» (como la demo). */
export function slugify(text: string, maxLength = 70): string {
  const plain = text
    .replace(/[äöüÄÖÜß]/g, (c) => GERMAN[c] ?? c)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (plain.length <= maxLength) return plain;
  const cut = plain.slice(0, maxLength);
  const lastDash = cut.lastIndexOf('-');
  return (lastDash > 20 ? cut.slice(0, lastDash) : cut).replace(/-+$/, '');
}

export type Tr = { es: string; en: string; de: string };

/** Las direcciones de los tres idiomas, del título de cada uno y la referencia
 *  al final (`…-c-101`, como la demo): así nunca chocan entre casas. Sin
 *  título en un idioma, sale del español; sin ninguno, solo la referencia. */
export function buildSlugs(title: Partial<Tr> | undefined, ref: string): Tr {
  const r = ref.toLowerCase();
  const es = slugify(title?.es ?? '');
  const one = (text: string | undefined) => {
    const base = slugify(text ?? '') || es;
    return base ? `${base}-${r}` : r;
  };
  return { es: one(title?.es), en: one(title?.en), de: one(title?.de) };
}

// --- Fechas ---------------------------------------------------------------------

/** Hoy en España peninsular, AAAA-MM-DD: la fecha que se apunta en el historial. */
export function madridToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// --- Historial de precios -------------------------------------------------------

export type PriceEntry = { date: string; price: number };

function isPositiveInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0;
}

/**
 * El historial tras un cambio de precio, con la forma de la demo: el primer
 * precio con su fecha de alta y después cada cambio con su día. Dos cambios
 * el mismo día dejan solo el último. Volver al precio anterior también se
 * apunta: fue un cambio real que el comprador pudo ver.
 */
export function nextPriceHistory(history: readonly PriceEntry[], previous: number, next: number, opts: { today: string; listedAt?: string }): PriceEntry[] {
  if (previous === next) return [...history];
  const out = [...history];
  if (out.length === 0) out.push({ date: opts.listedAt && opts.listedAt < opts.today ? opts.listedAt : opts.today, price: previous });
  const last = out[out.length - 1];
  if (last.date === opts.today) out[out.length - 1] = { date: opts.today, price: next };
  else out.push({ date: opts.today, price: next });
  // Si el último cambio del día devuelve el precio al del día anterior, la
  // entrada de hoy sobra.
  if (out.length >= 2 && out[out.length - 1].price === out[out.length - 2].price) out.pop();
  return out;
}

// --- Errores ----------------------------------------------------------------------

export type HomeError = { path: string; message: string };

const FIELD_LABELS: Record<string, string> = {
  type: 'Tipo',
  zone: 'Zona',
  title: 'Título',
  summary: 'Resumen',
  slugs: 'Dirección de la ficha',
  price: 'Precio',
  rent: 'Renta mensual',
  listedAt: 'Fecha de alta',
  availableFrom: 'Disponible desde',
  usable: 'Superficie útil',
  built: 'Superficie construida',
  plot: 'Parcela',
  bedrooms: 'Dormitorios',
  bathrooms: 'Baños',
  toilets: 'Aseos',
  floor: 'Planta',
  yearBuilt: 'Año de construcción',
  yearRenovated: 'Año de reforma',
  energy: 'Certificado energético',
  community: 'Comunidad',
  ibi: 'IBI',
  holding: 'Gastos de tenencia',
  touristLicence: 'Licencia turística',
  agent: 'Agente',
  tags: 'Etiquetas',
  lacks: 'Lo que no tiene',
  media: 'Vídeo y recorrido',
  term: 'Duración',
  months: 'Meses de estancia',
  furnished: 'Amueblado',
  pets: 'Mascotas',
  guarantee: 'Garantía adicional',
  includes: 'Lo incluido',
  showHistory: 'Historial de precios',
  featured: 'Destacada',
};

const LANG_LABELS: Record<string, string> = { es: 'español', en: 'inglés', de: 'alemán' };

/** Un aviso legible a partir de un error de Zod. Los de las reglas de la web
 *  (superRefine) ya vienen en español y se dejan tal cual, sin la referencia. */
export function issueMessage(issue: { code: string; path: (string | number)[]; message: string }, ref: string): HomeError {
  const path = issue.path.join('.');
  if (issue.code === 'custom') return { path, message: issue.message.replace(new RegExp(`^${ref}: `), '') };
  const [top, sub] = issue.path;
  const label = FIELD_LABELS[String(top)] ?? String(top);
  const where = typeof sub === 'string' && LANG_LABELS[sub] ? `${label} (${LANG_LABELS[sub]})` : label;
  if (issue.code === 'invalid_type' && /required/i.test(issue.message)) return { path, message: `${where}: falta.` };
  if (issue.code === 'unrecognized_keys') return { path, message: 'Hay un campo que no es del formato de la web.' };
  return { path, message: `${where}: valor no válido.` };
}

/** Lo que impide publicar la casa, con las reglas de la web y las de la agencia.
 *  LIMITACIÓN ACEPTADA: las reglas propias de la web (su superRefine: el
 *  certificado energético, la temporada, la garantía) solo corren cuando lo
 *  básico ya valida, como en su build. En un borrador a medias, el aviso del
 *  certificado aparece al completar lo demás; el formulario lo dice en el
 *  propio bloque («Obligatorio para publicar»). */
export function validateHome(
  operation: CarteraOperation,
  input: { ref: string; status: string; data: Record<string, unknown> },
  site: { agents: readonly { key: string }[] },
): HomeError[] {
  // Un borrador se valida como si se fuera a publicar: los avisos dicen qué
  // falta para poder hacerlo.
  const status = input.status === 'borrador' ? (operation === 'venta' ? 'venta' : 'disponible') : input.status;
  const candidate = { ...input.data, ref: input.ref, status, photos: [] };
  const parsed = (operation === 'venta' ? ventaFeedSchema : alquilerFeedSchema).safeParse(candidate);
  const errors = parsed.success ? [] : parsed.error.issues.map((i) => issueMessage(i, input.ref));
  // Que no se repita el mismo aviso por cada idioma de un campo.
  const unique = errors.filter((e, i) => errors.findIndex((x) => x.message === e.message) === i);
  const agent = input.data.agent;
  if (site.agents.length > 0 && typeof agent === 'string' && !site.agents.some((a) => a.key === agent)) {
    unique.push({ path: 'agent', message: 'Agente: no está en la lista de la agencia.' });
  }
  return unique;
}

// --- Guardar ----------------------------------------------------------------------

/** Solo las claves del formato que edita la agente, sin vacíos: un campo
 *  borrado en el formulario llega como null o '' y se quita. */
export function sanitizeHomeData(operation: CarteraOperation, raw: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set(EDITABLE_KEYS[operation]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.has(key)) continue;
    if (value === null || value === undefined || value === '') continue;
    out[key] = value;
  }
  return out;
}

export interface HomeBefore {
  ref: string;
  operation: CarteraOperation;
  status: string;
  data: Record<string, unknown>;
  errors: unknown;
  slugLocked: boolean;
  firstPublishedAt: Date | null;
}

export interface HomeSaveInput {
  status?: string;
  data: Record<string, unknown>;
}

export type HomeSaveResult =
  | {
      ok: true;
      status: string;
      data: Record<string, unknown>;
      errors: HomeError[];
      price: number | null;
      title: string | null;
      slugLocked: boolean;
      firstPublishedAt: Date | null;
      /** Lo que cambió, para la auditoría (sin datos personales: la casa no los tiene). */
      changes: { fields: string[]; price?: { from: number | null; to: number | null }; status?: { from: string; to: string } };
      /** Si el cambio llega a la web (estaba o queda en el feed): pone pendingSince. */
      affectsWeb: boolean;
    }
  | { ok: false; error: 'invalid_status' | 'published_to_draft' | 'too_large' };

export function priceOf(operation: CarteraOperation, data: Record<string, unknown>): number | null {
  const v = operation === 'venta' ? data.price : data.rent;
  return isPositiveInt(v) ? v : null;
}

function titleOf(data: Record<string, unknown>): string | null {
  const t = data.title as Partial<Tr> | undefined;
  return typeof t?.es === 'string' && t.es.trim() ? t.es.trim().slice(0, 200) : null;
}

export function isPublishableNow(status: string, errors: readonly unknown[] | null): boolean {
  return status !== 'borrador' && (!errors || errors.length === 0);
}

/**
 * La casa tal como queda al guardar: datos limpios, direcciones, historial de
 * precios, errores y si se publica por primera vez. No toca la base de datos.
 */
export function computeHomeSave(
  before: HomeBefore,
  input: HomeSaveInput,
  site: { agents: readonly { key: string }[] },
  now: Date = new Date(),
): HomeSaveResult {
  const status = input.status ?? before.status;
  if (!HOME_STATUSES[before.operation].includes(status)) return { ok: false, error: 'invalid_status' };
  if (before.firstPublishedAt && status === 'borrador') return { ok: false, error: 'published_to_draft' };

  const data = sanitizeHomeData(before.operation, input.data);

  // Direcciones: del título mientras no se haya publicado; después, las de siempre.
  const prevSlugs = before.data.slugs as Tr | undefined;
  data.slugs = before.slugLocked && prevSlugs ? prevSlugs : buildSlugs(data.title as Partial<Tr> | undefined, before.ref);

  // Historial de precios: solo venta (el alquiler no lo lleva en la web) y
  // solo desde que la casa se publicó; antes, cambiar el precio de un
  // borrador no es una bajada que haya visto nadie.
  const prevPrice = priceOf(before.operation, before.data);
  const nextPrice = priceOf(before.operation, data);
  if (before.operation === 'venta') {
    const history = Array.isArray(before.data.priceHistory) ? (before.data.priceHistory as PriceEntry[]) : [];
    data.priceHistory =
      before.firstPublishedAt && prevPrice !== null && nextPrice !== null
        ? nextPriceHistory(history, prevPrice, nextPrice, { today: madridToday(now), listedAt: typeof data.listedAt === 'string' ? data.listedAt : undefined })
        : history;
  }

  if (JSON.stringify(data).length > MAX_HOME_DATA_CHARS) return { ok: false, error: 'too_large' };

  const errors = validateHome(before.operation, { ref: before.ref, status, data }, site);
  const publishable = isPublishableNow(status, errors);
  const wasPublishable = isPublishableNow(before.status, Array.isArray(before.errors) ? before.errors : before.errors ? [before.errors] : null);
  const firstPublishedAt = before.firstPublishedAt ?? (publishable ? now : null);

  const keys = new Set([...Object.keys(before.data), ...Object.keys(data)]);
  const fields = [...keys].filter((k) => JSON.stringify(before.data[k]) !== JSON.stringify(data[k])).sort();
  const changes: Extract<HomeSaveResult, { ok: true }>['changes'] = { fields };
  if (prevPrice !== nextPrice) changes.price = { from: prevPrice, to: nextPrice };
  if (before.status !== status) changes.status = { from: before.status, to: status };

  return {
    ok: true,
    status,
    data,
    errors,
    price: nextPrice,
    title: titleOf(data),
    // Se congelan al entrar en el feed por primera vez: desde ese momento el
    // siguiente build puede publicar la ficha con esas direcciones.
    slugLocked: before.slugLocked || publishable,
    firstPublishedAt,
    changes,
    affectsWeb: (publishable || wasPublishable) && (fields.length > 0 || before.status !== status),
  };
}

/** Solo se borra un borrador que nunca se ha publicado. */
export function canDeleteHome(home: { status: string; firstPublishedAt: Date | null }): boolean {
  return home.status === 'borrador' && !home.firstPublishedAt;
}

/** Los datos con los que nace una casa nueva: un borrador vacío con la fecha
 *  de alta de hoy y el primer agente de la agencia, si hay. */
export function initialHomeData(operation: CarteraOperation, site: { agents: readonly { key: string }[] }, now: Date = new Date()): Record<string, unknown> {
  const today = madridToday(now);
  const empty = { es: '', en: '', de: '' };
  const base: Record<string, unknown> = { title: { ...empty }, summary: { ...empty }, listedAt: today };
  if (site.agents[0]) base.agent = site.agents[0].key;
  if (operation === 'alquiler') Object.assign(base, { term: 'larga', availableFrom: today, furnished: false, pets: false });
  return base;
}
