import 'server-only';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { inspectImage, type UploadImageType } from '../site-uploads';
import { CARTERA_PRODUCT_CODE, type Db } from './site';
import { isPublishable } from './feed';

// =============================================================================
// Cartera — las fotos de las casas, en disco (decisión A del 19/11/2026).
//
// No van en Postgres como las imágenes del editor de webs: con 100 casas de 30
// fotos a ~0,8 MB son unos 2,4 GB por cliente, y la base de datos y cada copia
// crecerían en esa cantidad. Viven en el volumen `cartera-fotos` de la VPS,
// montado en el directorio de CARTERA_FOTOS_DIR. El fichero se llama por su
// storageKey: `<siteId>/<homeId>/<photoId>.<ext>`, todo ids que pone el portal.
//
// Las fotos 360° (CarteraPano, 25/11/2026) viven en el mismo volumen, con la
// misma forma de clave, y salen por la misma ruta pública: para la web y para
// la copia diaria (scripts/backup-postgres.sh, que empaqueta el volumen
// entero) son un fichero más. Lo que cambia está en «Fotos 360°», abajo.
//
// =============================================================================

export const PHOTO_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const STORAGE_KEY_RE = new RegExp(`^${UUID}/${UUID}/${UUID}\\.(jpg|png|webp)$`);
const UUID_RE = new RegExp(`^${UUID}$`, 'i');

export function isPhotoId(value: string): boolean {
  return UUID_RE.test(value);
}

/** El directorio del volumen. Con `||`: declarada y vacía cuenta como ausente
 *  (trampa 4 de CLAUDE.md). Sin él no hay fotos que servir. */
export function carteraFotosDir(): string | null {
  return process.env.CARTERA_FOTOS_DIR?.trim() || null;
}

/**
 * La ruta absoluta de una foto, o null si la clave no tiene la forma que pone
 * el portal. Doble defensa contra salir del directorio: la clave solo admite
 * ids y una extensión conocida, y la ruta resuelta tiene que seguir dentro.
 */
export function resolvePhotoPath(dir: string, storageKey: string): string | null {
  if (!STORAGE_KEY_RE.test(storageKey)) return null;
  const root = path.resolve(dir);
  const full = path.resolve(root, storageKey);
  if (!full.startsWith(root + path.sep)) return null;
  return full;
}

const PUBLIC_PHOTO_SELECT = {
  id: true,
  storageKey: true,
  mime: true,
  sha256: true,
  home: {
    select: {
      status: true,
      errors: true,
      site: { select: { clientProduct: { select: { status: true, product: { select: { code: true } } } } } },
    },
  },
} as const;

/** La foto, solo si su casa es publicable y la contratación está activa.
 *  Una foto de un borrador, de una casa con errores o de una agencia que ya
 *  no está activa no existe para internet: 404. Vale igual para una foto 360°:
 *  la web la descarga por la misma dirección, y un uuid no se repite entre
 *  las dos tablas. */
export async function findPublicPhoto(db: Db, photoId: string) {
  if (!isPhotoId(photoId)) return null;
  const id = photoId.toLowerCase();
  const photo =
    (await db.carteraPhoto.findUnique({ where: { id }, select: PUBLIC_PHOTO_SELECT })) ??
    (await db.carteraPano.findUnique({ where: { id }, select: PUBLIC_PHOTO_SELECT }));
  if (!photo) return null;
  const contract = photo.home.site.clientProduct;
  if (contract.status !== 'active' || contract.product.code !== CARTERA_PRODUCT_CODE) return null;
  if (!isPublishable(photo.home)) return null;
  if (!(PHOTO_MIMES as readonly string[]).includes(photo.mime)) return null;
  return { id: photo.id, storageKey: photo.storageKey, mime: photo.mime, sha256: photo.sha256 };
}

export async function readPhotoFile(storageKey: string): Promise<Buffer | null> {
  const dir = carteraFotosDir();
  if (!dir) return null;
  const full = resolvePhotoPath(dir, storageKey);
  if (!full) return null;
  try {
    return await readFile(full);
  } catch {
    return null;
  }
}

// --- Subida, orden y borrado (PR 2) -------------------------------------------
//
// Como site-uploads.ts: el NAVEGADOR reduce a 2.400 px de lado y vuelve a
// codificar (se pierden EXIF y GPS: la ubicación exacta de la casa no puede
// salir en una foto), y el SERVIDOR no se fía: mira los primeros bytes (JPEG,
// PNG o WebP, nunca SVG), las medidas de la cabecera, el peso y cuántas lleva
// la casa. El nombre del fichero lo pone el portal: el id de la fila.

export const MAX_PHOTO_BYTES = 3_000_000;
export const MAX_PHOTO_SIDE = 2400;
export const MAX_PHOTOS_PER_HOME = 40;

export type PhotoCheckError = 'too_large' | 'not_an_image' | 'too_big_dimensions';

export function checkPhoto(buf: Buffer): { ok: true; info: UploadImageType } | { ok: false; error: PhotoCheckError } {
  if (buf.length > MAX_PHOTO_BYTES) return { ok: false, error: 'too_large' };
  const info = inspectImage(buf);
  if (!info || !info.width || !info.height) return { ok: false, error: 'not_an_image' };
  if (info.width > MAX_PHOTO_SIDE || info.height > MAX_PHOTO_SIDE) return { ok: false, error: 'too_big_dimensions' };
  return { ok: true, info };
}

/** El archivo de una petición multipart (campo «archivo»), con tope: uno
 *  enorme se rechaza por su cabecera sin cargarlo en memoria. */
export async function readPhotoUpload(req: Request, maxBytes: number = MAX_PHOTO_BYTES): Promise<{ ok: true; buf: Buffer } | { ok: false; status: number; error: string }> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > maxBytes + 64_000) return { ok: false, status: 413, error: 'too_large' };
  const form = await req.formData().catch(() => null);
  const file = form?.get('archivo');
  if (!file || typeof file === 'string') return { ok: false, status: 400, error: 'invalid_body' };
  return { ok: true, buf: Buffer.from(await file.arrayBuffer()) };
}

export const PHOTO_ERROR_STATUS: Record<string, number> = {
  too_large: 413,
  not_an_image: 415,
  too_big_dimensions: 422,
  too_many_photos: 409,
  not_equirectangular: 422,
  too_many_panos: 409,
  storage_not_configured: 503,
};

/** El texto alternativo: solo los idiomas con texto, recortado. */
export function cleanAlt(value: unknown): { es?: string; en?: string; de?: string } {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const out: { es?: string; en?: string; de?: string } = {};
  for (const lang of ['es', 'en', 'de'] as const) {
    const text = v[lang];
    if (typeof text === 'string' && text.trim()) out[lang] = text.trim().slice(0, 300);
  }
  return out;
}

export type StorePhotoResult =
  | { ok: true; photo: { id: string; width: number; height: number; bytes: number; position: number; mime: string } }
  | { ok: false; error: PhotoCheckError | 'too_many_photos' | 'storage_not_configured' };

/**
 * Guarda una foto de una casa: fichero en el volumen y fila en Postgres. Va a
 * la última posición. Si la fila no se puede crear, el fichero se borra: no
 * quedan ficheros huérfanos en el volumen.
 */
export async function storeHomePhoto(db: Db, home: { id: string; siteId: string }, buf: Buffer): Promise<StorePhotoResult> {
  const checked = checkPhoto(buf);
  if (!checked.ok) return checked;
  const dir = carteraFotosDir();
  if (!dir) return { ok: false, error: 'storage_not_configured' };

  const count = await db.carteraPhoto.count({ where: { homeId: home.id } });
  if (count >= MAX_PHOTOS_PER_HOME) return { ok: false, error: 'too_many_photos' };
  const last = await db.carteraPhoto.findFirst({ where: { homeId: home.id }, orderBy: { position: 'desc' }, select: { position: true } });
  const position = (last?.position ?? -1) + 1;

  const photo = await writeToVolume(dir, home, buf, checked.info, position, (data) => db.carteraPhoto.create({ data }));
  if (!photo) return { ok: false, error: 'storage_not_configured' };
  return { ok: true, photo };
}

type VolumeRow = { id: string; homeId: string; storageKey: string; mime: string; width: number; height: number; bytes: number; sha256: string; position: number };

/** El fichero en el volumen y su fila (la crea `createRow`). Si la fila no se
 *  puede crear, el fichero se borra: no quedan ficheros huérfanos. Null si la
 *  clave no sale con la forma que pone el portal (no debería pasar). */
async function writeToVolume(
  dir: string,
  home: { id: string; siteId: string },
  buf: Buffer,
  info: UploadImageType,
  position: number,
  createRow: (row: VolumeRow) => Promise<unknown>,
): Promise<{ id: string; width: number; height: number; bytes: number; position: number; mime: string } | null> {
  const id = randomUUID();
  const storageKey = `${home.siteId}/${home.id}/${id}.${info.ext}`;
  const full = resolvePhotoPath(dir, storageKey);
  if (!full) return null;
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, buf, { flag: 'wx' });
  try {
    await createRow({
      id,
      homeId: home.id,
      storageKey,
      mime: info.contentType,
      width: info.width,
      height: info.height,
      bytes: buf.length,
      sha256: createHash('sha256').update(buf).digest('hex'),
      position,
    });
  } catch (err) {
    await rm(full, { force: true });
    throw err;
  }
  return { id, width: info.width, height: info.height, bytes: buf.length, position, mime: info.contentType };
}

// --- Fotos 360° (25/11/2026) --------------------------------------------------
//
// El mismo flujo que las fotos: el navegador las reduce y las vuelve a
// codificar (sin EXIF ni GPS) y el servidor comprueba tipo, medidas y peso.
// Tres diferencias:
//   - Más grandes: hasta 4.096 px de ancho, que es lo que usa el visor de la
//     web (panoSrc en su src/lib/photos.ts: una textura WebGL que admite
//     cualquier móvil), y hasta 6 MB.
//   - Equirrectangulares: el doble de anchas que de altas, con la misma
//     tolerancia que el esquema del feed (panoSchema). Se comprueba al subir:
//     una que no lo fuera dejaría la casa entera fuera del feed sin que la
//     agencia supiera por qué.
//   - Hasta 30 por casa (panos.max(30) del formato) y sin texto alternativo.

export const MAX_PANO_BYTES = 6_000_000;
export const MAX_PANO_SIDE = 4096;
export const MAX_PANOS_PER_HOME = 30;

/** 2:1 con la tolerancia de panoSchema (lib/cartera/schema.ts). */
export function isEquirectangular(width: number, height: number): boolean {
  return width > 0 && height > 0 && Math.abs(width / height - 2) < 0.02;
}

export type PanoCheckError = PhotoCheckError | 'not_equirectangular';

export function checkPano(buf: Buffer): { ok: true; info: UploadImageType } | { ok: false; error: PanoCheckError } {
  if (buf.length > MAX_PANO_BYTES) return { ok: false, error: 'too_large' };
  const info = inspectImage(buf);
  if (!info || !info.width || !info.height) return { ok: false, error: 'not_an_image' };
  if (info.width > MAX_PANO_SIDE || info.height > MAX_PANO_SIDE) return { ok: false, error: 'too_big_dimensions' };
  if (!isEquirectangular(info.width, info.height)) return { ok: false, error: 'not_equirectangular' };
  return { ok: true, info };
}

export type StorePanoResult =
  | { ok: true; pano: { id: string; width: number; height: number; bytes: number; position: number; mime: string } }
  | { ok: false; error: PanoCheckError | 'too_many_panos' | 'storage_not_configured' };

/** Guarda una foto 360° de una casa, al final de su orden. */
export async function storeHomePano(db: Db, home: { id: string; siteId: string }, buf: Buffer): Promise<StorePanoResult> {
  const checked = checkPano(buf);
  if (!checked.ok) return checked;
  const dir = carteraFotosDir();
  if (!dir) return { ok: false, error: 'storage_not_configured' };

  const count = await db.carteraPano.count({ where: { homeId: home.id } });
  if (count >= MAX_PANOS_PER_HOME) return { ok: false, error: 'too_many_panos' };
  const last = await db.carteraPano.findFirst({ where: { homeId: home.id }, orderBy: { position: 'desc' }, select: { position: true } });
  const position = (last?.position ?? -1) + 1;

  const pano = await writeToVolume(dir, home, buf, checked.info, position, (data) => db.carteraPano.create({ data }));
  if (!pano) return { ok: false, error: 'storage_not_configured' };
  return { ok: true, pano };
}

/** Borra los ficheros de unas fotos. Uno que ya no estaba no es un error. */
export async function removePhotoFiles(storageKeys: readonly string[]): Promise<void> {
  const dir = carteraFotosDir();
  if (!dir) return;
  for (const key of storageKeys) {
    const full = resolvePhotoPath(dir, key);
    if (full) await rm(full, { force: true });
  }
}

/** El orden nuevo tiene que nombrar exactamente las fotos de la casa. */
export function isSamePhotoSet(current: readonly string[], order: readonly string[]): boolean {
  if (current.length !== order.length) return false;
  const set = new Set(order);
  return set.size === order.length && current.every((id) => set.has(id));
}
