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

/** La foto, solo si su casa es publicable y la contratación está activa.
 *  Una foto de un borrador, de una casa con errores o de una agencia que ya
 *  no está activa no existe para internet: 404. */
export async function findPublicPhoto(db: Db, photoId: string) {
  if (!isPhotoId(photoId)) return null;
  const photo = await db.carteraPhoto.findUnique({
    where: { id: photoId.toLowerCase() },
    select: {
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
    },
  });
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
export async function readPhotoUpload(req: Request): Promise<{ ok: true; buf: Buffer } | { ok: false; status: number; error: string }> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_PHOTO_BYTES + 64_000) return { ok: false, status: 413, error: 'too_large' };
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

  const id = randomUUID();
  const storageKey = `${home.siteId}/${home.id}/${id}.${checked.info.ext}`;
  const full = resolvePhotoPath(dir, storageKey);
  if (!full) return { ok: false, error: 'storage_not_configured' };
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, buf, { flag: 'wx' });
  try {
    await db.carteraPhoto.create({
      data: {
        id,
        homeId: home.id,
        storageKey,
        mime: checked.info.contentType,
        width: checked.info.width,
        height: checked.info.height,
        bytes: buf.length,
        sha256: createHash('sha256').update(buf).digest('hex'),
        position,
      },
    });
  } catch (err) {
    await rm(full, { force: true });
    throw err;
  }
  return { ok: true, photo: { id, width: checked.info.width, height: checked.info.height, bytes: buf.length, position, mime: checked.info.contentType } };
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
