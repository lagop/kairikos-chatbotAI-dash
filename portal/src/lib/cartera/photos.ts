import 'server-only';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
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
// La subida (navegador que reduce y quita EXIF/GPS, tipo por los primeros
// bytes, 3 MB y 40 fotos por casa) es del PR 2. Aquí solo se sirven.
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
