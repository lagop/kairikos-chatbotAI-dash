import 'server-only';
import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { referencedUploads } from './site-content';

/** SITE_UPLOAD_PATH_RE sin anclas, para buscarla dentro de un texto. */
const UPLOAD_PATH_IN_TEXT = /assets\/subidas\/[a-f0-9]{18}\.(?:jpg|png|webp)/g;

// =============================================================================
// 28/10/2026 — el logo y las fotos que sube el cliente a su web.
//
// Hasta hoy el editor decía «para poner tu foto, mándanosla por soporte y la
// subimos nosotros», pero no existía ninguna forma de subirla: ni pantalla ni
// ruta, ni de cliente ni de operador. Toda web de oficios salía con la foto
// de banco de su oficio y el nombre escrito en vez del logo.
//
// Quién hace qué:
// - El NAVEGADOR del cliente reduce la imagen y la vuelve a codificar antes
//   de subirla (SiteContentEditor, prepararImagen). Llega pesando poco y sin
//   los datos de la cámara: una foto de móvil lleva el GPS de donde se hizo,
//   que suele ser la casa de un cliente suyo. No hay librería de imágenes en
//   el servidor a propósito: sharp es nativa y el contenedor no la lleva.
// - El SERVIDOR (aquí) no se fía: comprueba por los primeros bytes que es un
//   JPEG, PNG o WebP de verdad (nunca un SVG, que puede llevar JavaScript y la
//   web alojada se sirve desde nuestro dominio), lee sus medidas de la
//   cabecera y pone él el nombre del archivo.
// - El CONTENIDO la cita por su ruta (site-content.ts, SITE_UPLOAD_PATH_RE) y
//   la publicación sube solo las citadas (website-publish.ts).
//
// Las que dejan de citarse (una foto cambiada por otra) se borran al llegar al
// tope de una web, y solo si el contenido guardado no las usa.
// =============================================================================

/** Lo que llega ya reducido pesa 100–400 KB; el tope es para que nadie meta
 *  aquí un archivo de 20 MB saltándose el editor. */
export const MAX_UPLOAD_BYTES = 2_000_000;
/** El editor reduce a 1920 px el lado largo (800 el logo). */
export const MAX_UPLOAD_SIDE = 2400;
/** Por web. Las que sobran, las no usadas, se recogen al subir una nueva. */
export const MAX_IMAGES_PER_WEBSITE = 30;

export type UploadImageType = { ext: 'jpg' | 'png' | 'webp'; contentType: string; width: number; height: number };

/** Qué imagen es, mirando sus bytes y no lo que diga el navegador. Null si no
 *  es una JPEG, PNG o WebP que se pueda leer. Exportada para las pruebas. */
export function inspectImage(buf: Buffer): UploadImageType | null {
  if (buf.length < 32) return null;
  // PNG: firma de 8 bytes y el bloque IHDR justo después, con ancho y alto.
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && buf.toString('ascii', 12, 16) === 'IHDR') {
    return { ext: 'png', contentType: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // WebP: RIFF....WEBP y uno de sus tres formatos.
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8 ' && buf.length >= 30) {
      return { ext: 'webp', contentType: 'image/webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
      const b = buf.readUInt32LE(21);
      return { ext: 'webp', contentType: 'image/webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X' && buf.length >= 30) {
      return { ext: 'webp', contentType: 'image/webp', width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    }
    return null;
  }
  // JPEG: los segmentos hasta el SOF (inicio de fotograma), que lleva las medidas.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      if (marker === 0xff) { i++; continue; }
      const len = buf.readUInt16BE(i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { ext: 'jpg', contentType: 'image/jpeg', width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

export type StoreImageResult =
  | { ok: true; path: string; width: number; height: number; bytes: number }
  | { ok: false; error: 'too_large' | 'not_an_image' | 'too_big_dimensions' | 'too_many_images' };

/** Guarda una imagen de la web y devuelve su ruta dentro del sitio. */
export async function storeWebsiteImage(
  prisma: PrismaClient,
  website: { id: string; content: unknown },
  buf: Buffer,
): Promise<StoreImageResult> {
  if (buf.length > MAX_UPLOAD_BYTES) return { ok: false, error: 'too_large' };
  const info = inspectImage(buf);
  if (!info || !info.width || !info.height) return { ok: false, error: 'not_an_image' };
  if (info.width > MAX_UPLOAD_SIDE || info.height > MAX_UPLOAD_SIDE) return { ok: false, error: 'too_big_dimensions' };

  const count = await prisma.clientWebsiteImage.count({ where: { websiteId: website.id } });
  if (count >= MAX_IMAGES_PER_WEBSITE) {
    // Se recogen las que el contenido guardado ya no cita. Las recién
    // subidas y todavía sin guardar también entran: si el cliente sube 30
    // fotos sin guardar ninguna, la 31 desplaza a la primera. Lo que se
    // conserva sale del contenido EN BRUTO y no del esquema: un contenido que
    // por lo que sea no pasara la validación no puede llevarse por delante
    // las fotos que sí usa (lo encontró la prueba con 30 bloques).
    const keep = [...new Set(JSON.stringify(website.content ?? null).match(UPLOAD_PATH_IN_TEXT) ?? [])];
    const unused = await prisma.clientWebsiteImage.findMany({
      where: { websiteId: website.id, path: { notIn: keep } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
      take: count - MAX_IMAGES_PER_WEBSITE + 1,
    });
    if (count - unused.length >= MAX_IMAGES_PER_WEBSITE) return { ok: false, error: 'too_many_images' };
    await prisma.clientWebsiteImage.deleteMany({ where: { id: { in: unused.map((u) => u.id) } } });
  }

  const path = `assets/subidas/${randomBytes(9).toString('hex')}.${info.ext}`;
  await prisma.clientWebsiteImage.create({
    data: { websiteId: website.id, path, contentType: info.contentType, content: buf, width: info.width, height: info.height },
  });
  return { ok: true, path, width: info.width, height: info.height, bytes: buf.length };
}

/** Las imágenes que cita el contenido, como archivos de la web. */
export async function referencedImageFiles(prisma: PrismaClient, websiteId: string, content: Parameters<typeof referencedUploads>[0]): Promise<{ path: string; content: Buffer }[]> {
  const paths = referencedUploads(content);
  if (!paths.length) return [];
  const rows = await prisma.clientWebsiteImage.findMany({ where: { websiteId, path: { in: paths } }, select: { path: true, content: true } });
  return rows.map((r) => ({ path: r.path, content: Buffer.from(r.content) }));
}
