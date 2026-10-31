import 'server-only';
import { NextResponse } from 'next/server';
import type { Prisma, PrismaClient } from '@prisma/client';
import { SITE_UPLOAD_PATH_RE } from './site-content';
import {
  MAX_IMAGES_PER_WEBSITE,
  UPLOAD_ERROR_STATUS,
  checkUploadedImage,
  newUploadPath,
  readUploadedFile,
  uploadPathsIn,
  type StoreImageResult,
} from './site-uploads';
import { isUuid } from './web-draft-edit';
import { logError } from './observability';

// =============================================================================
// 31/10/2026 — el logo y las fotos del borrador de un prospecto.
//
// Orlando, al saber que el editor de borradores (#362) no subía fotos: «que se
// puedan subir sería bueno». No se podía porque las subidas eran de una web
// (ClientWebsiteImage) y un prospecto todavía no tiene ninguna. Ahora el
// borrador tiene las suyas (ProspectingWebDraftImage), con las mismas reglas
// que las de una web (site-uploads.ts): el navegador las reduce y les quita
// los datos de la cámara, el servidor comprueba los bytes y pone el nombre, y
// el contenido las cita por su ruta `assets/subidas/…`.
//
// Lo que cambia respecto a una web:
// - DÓNDE SE VEN. El borrador se sirve en /borrador/<testigo>, sin barra al
//   final, así que una ruta relativa acabaría en /borrador/assets/…. Al
//   pintarlo, las rutas de subida se escriben bajo /borrador/<testigo>/
//   (withDraftUploadsBase), que es donde las sirve la ruta pública; la vista
//   en vivo del editor las pide al mismo sitio. El testigo ya es la llave del
//   borrador entero: quien puede ver la página puede ver sus fotos.
// - QUÉ PASA AL COMPRAR. La web nace con el contenido del borrador, y con él
//   las rutas de sus fotos: copyDraftImagesToWebsite las copia a la web en la
//   misma transacción, o la web nacería con huecos.
// - Sin auditoría propia: solo sube el operador, y lo que cuenta (que el
//   contenido pase a citarlas) queda en el historial del borrador al guardar.
// =============================================================================

/** El mismo tope que una web: más de 30 fotos en una portada no caben. */
export const MAX_IMAGES_PER_DRAFT = MAX_IMAGES_PER_WEBSITE;

/** Dónde sirve la ruta pública las fotos del borrador con este testigo. */
export function draftUploadsBase(shareToken: string): string {
  return `/borrador/${shareToken}/`;
}

/** Una ruta de subida que no va precedida de otra cosa de la URL: la del
 *  atributo (src="…", href="…"), la de un srcset y la de un url(…) de CSS. */
const RELATIVE_UPLOAD_RE = /(^|["'(\s,=])(assets\/subidas\/[a-f0-9]{18}\.(?:jpg|png|webp))/g;

/** El HTML del borrador con sus fotos subidas apuntando a `base`. */
export function withDraftUploadsBase(html: string, base: string): string {
  return html.replace(RELATIVE_UPLOAD_RE, (_m, pre: string, path: string) => `${pre}${base}${path}`);
}

/** Guarda una foto del borrador y devuelve su ruta. Al llegar al tope se
 *  recogen las que el contenido guardado no cita, igual que en una web. */
export async function storeDraftImage(
  prisma: PrismaClient,
  draft: { id: string; content: unknown },
  buf: Buffer,
): Promise<StoreImageResult> {
  const checked = checkUploadedImage(buf);
  if (!checked.ok) return checked;
  const { info } = checked;

  const count = await prisma.prospectingWebDraftImage.count({ where: { draftId: draft.id } });
  if (count >= MAX_IMAGES_PER_DRAFT) {
    const unused = await prisma.prospectingWebDraftImage.findMany({
      where: { draftId: draft.id, path: { notIn: uploadPathsIn(draft.content) } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
      take: count - MAX_IMAGES_PER_DRAFT + 1,
    });
    if (count - unused.length >= MAX_IMAGES_PER_DRAFT) return { ok: false, error: 'too_many_images' };
    await prisma.prospectingWebDraftImage.deleteMany({ where: { id: { in: unused.map((u) => u.id) } } });
  }

  const path = newUploadPath(info.ext);
  await prisma.prospectingWebDraftImage.create({
    data: { draftId: draft.id, path, contentType: info.contentType, content: buf, width: info.width, height: info.height },
  });
  return { ok: true, path, width: info.width, height: info.height, bytes: buf.length };
}

/** La subida desde el editor del operador (multipart, campo «archivo»). Misma
 *  forma de respuesta que la de una web, que es la que entiende el editor. */
export async function uploadDraftImage(
  prisma: PrismaClient,
  leadId: string,
  req: Request,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!isUuid(leadId)) return { status: 404, body: { error: 'not_found' } };
  const draft = await prisma.prospectingWebDraft.findUnique({ where: { leadId }, select: { id: true, content: true, templateId: true } });
  if (!draft) return { status: 404, body: { error: 'not_found' } };
  // El diseño antiguo no tiene dónde poner una foto (web-draft-editor.ts).
  if (!draft.templateId || draft.content == null) return { status: 409, body: { error: 'old_design' } };
  const file = await readUploadedFile(req);
  if (!file.ok) return { status: file.status, body: { error: file.error } };

  try {
    const result = await storeDraftImage(prisma, draft, file.buf);
    if (!result.ok) return { status: UPLOAD_ERROR_STATUS[result.error] ?? 400, body: { error: result.error } };
    return { status: 200, body: { ok: true, path: result.path, width: result.width, height: result.height } };
  } catch (err) {
    logError('web_draft.image_upload_failed', err, { leadId });
    return { status: 500, body: { error: 'internal_error' } };
  }
}

/** Sirve una foto del borrador. `draft` dice de qué borrador: por su testigo
 *  (la ruta pública) o por el prospecto (la del operador). */
export async function serveDraftImage(
  prisma: PrismaClient,
  draft: Prisma.ProspectingWebDraftWhereInput,
  path: string,
): Promise<NextResponse> {
  const notFound = () => new NextResponse('No encontrada.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  if (!SITE_UPLOAD_PATH_RE.test(path)) return notFound();
  const image = await prisma.prospectingWebDraftImage.findFirst({ where: { path, draft }, select: { contentType: true, content: true } });
  if (!image) return notFound();
  return new NextResponse(new Uint8Array(image.content), {
    status: 200,
    headers: {
      'content-type': image.contentType,
      // El nombre es aleatorio y no se reutiliza: la misma ruta es siempre la
      // misma foto. Privada, como la página: el enlace es de un negocio.
      'cache-control': 'private, max-age=86400',
      'x-robots-tag': 'noindex, nofollow',
      'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * Al crear la web desde el borrador: las fotos que cita su contenido pasan a
 * la web, con la misma ruta, en la transacción que la crea. Las que el
 * contenido ya no cita se quedan en el borrador.
 */
export async function copyDraftImagesToWebsite(
  tx: Prisma.TransactionClient,
  draft: Prisma.ProspectingWebDraftWhereInput,
  websiteId: string,
  content: unknown,
): Promise<number> {
  const paths = uploadPathsIn(content);
  if (!paths.length) return 0;
  const images = await tx.prospectingWebDraftImage.findMany({
    where: { draft, path: { in: paths } },
    select: { path: true, contentType: true, content: true, width: true, height: true },
  });
  if (!images.length) return 0;
  const { count } = await tx.clientWebsiteImage.createMany({
    data: images.map((img) => ({ websiteId, ...img })),
    skipDuplicates: true,
  });
  return count;
}
