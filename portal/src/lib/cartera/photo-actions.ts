import 'server-only';
import type { Prisma, PrismaClient } from '@prisma/client';
import { auditCartera } from './site';
import { markPending } from './homes';
import { isPublishable } from './feed';
import { PHOTO_ERROR_STATUS, cleanAlt, isSamePhotoSet, readPhotoUpload, removePhotoFiles, storeHomePhoto } from './photos';
import { logError } from '../observability';

// =============================================================================
// Cartera — lo que hace el panel con las fotos de una casa: subir, ordenar,
// cambiar el texto alternativo y quitar. Cada una deja su auditoría (ids,
// medidas y peso; nunca la imagen) y, si la casa está en el feed, marca el
// sitio como pendiente de publicar.
// =============================================================================

type Site = { id: string; clientId: string };
type Home = { id: string; siteId: string; ref: string; status: string; errors: Prisma.JsonValue };
type Result = { status: number; body: Record<string, unknown> };

export async function uploadHomePhoto(prisma: PrismaClient, site: Site, home: Home, req: Request, actor: string): Promise<Result> {
  const file = await readPhotoUpload(req);
  if (!file.ok) return { status: file.status, body: { error: file.error } };
  try {
    const r = await storeHomePhoto(prisma, home, file.buf);
    if (!r.ok) return { status: PHOTO_ERROR_STATUS[r.error] ?? 400, body: { error: r.error } };
    await prisma.$transaction(async (tx) => {
      await auditCartera(tx, {
        siteId: site.id,
        clientId: site.clientId,
        entity: 'photo',
        entityId: r.photo.id,
        action: 'photo_added',
        actor,
        metadata: { ref: home.ref, width: r.photo.width, height: r.photo.height, bytes: r.photo.bytes },
      });
      if (isPublishable(home)) await markPending(tx, site.id);
    });
    return { status: 200, body: { ok: true, photo: r.photo } };
  } catch (err) {
    logError('cartera.photo_upload', err, { homeId: home.id });
    return { status: 500, body: { error: 'internal_error' } };
  }
}

export async function reorderHomePhotos(prisma: PrismaClient, site: Site, home: Home, order: string[], actor: string): Promise<Result> {
  const current = await prisma.carteraPhoto.findMany({ where: { homeId: home.id }, select: { id: true } });
  if (!isSamePhotoSet(current.map((p) => p.id), order)) return { status: 400, body: { error: 'invalid_order' } };
  await prisma.$transaction(async (tx) => {
    for (const [position, id] of order.entries()) await tx.carteraPhoto.update({ where: { id }, data: { position } });
    await auditCartera(tx, { siteId: site.id, clientId: site.clientId, entity: 'home', entityId: home.id, action: 'photos_reordered', actor, metadata: { ref: home.ref, count: order.length } });
    if (isPublishable(home)) await markPending(tx, site.id);
  });
  return { status: 200, body: { ok: true } };
}

export async function setHomePhotoAlt(prisma: PrismaClient, site: Site, home: Home, photoId: string, alt: unknown, actor: string): Promise<Result> {
  const photo = await prisma.carteraPhoto.findFirst({ where: { id: photoId, homeId: home.id }, select: { id: true } });
  if (!photo) return { status: 404, body: { error: 'not_found' } };
  const clean = cleanAlt(alt);
  await prisma.$transaction(async (tx) => {
    await tx.carteraPhoto.update({ where: { id: photo.id }, data: { alt: clean } });
    await auditCartera(tx, { siteId: site.id, clientId: site.clientId, entity: 'photo', entityId: photo.id, action: 'photo_alt_updated', actor, metadata: { ref: home.ref, langs: Object.keys(clean) } });
    if (isPublishable(home)) await markPending(tx, site.id);
  });
  return { status: 200, body: { ok: true, alt: clean } };
}

export async function deleteHomePhoto(prisma: PrismaClient, site: Site, home: Home, photoId: string, actor: string): Promise<Result> {
  const photo = await prisma.carteraPhoto.findFirst({ where: { id: photoId, homeId: home.id }, select: { id: true, storageKey: true } });
  if (!photo) return { status: 404, body: { error: 'not_found' } };
  await prisma.$transaction(async (tx) => {
    await tx.carteraPhoto.delete({ where: { id: photo.id } });
    // Las que quedan, corridas para no dejar huecos en el orden.
    const rest = await tx.carteraPhoto.findMany({ where: { homeId: home.id }, orderBy: { position: 'asc' }, select: { id: true, position: true } });
    for (const [position, p] of rest.entries()) if (p.position !== position) await tx.carteraPhoto.update({ where: { id: p.id }, data: { position } });
    await auditCartera(tx, { siteId: site.id, clientId: site.clientId, entity: 'photo', entityId: photo.id, action: 'photo_removed', actor, metadata: { ref: home.ref } });
    if (isPublishable(home)) await markPending(tx, site.id);
  });
  // Después de confirmar: si la transacción fallara, la foto seguiría en la
  // ficha y su fichero tiene que seguir en el volumen.
  await removePhotoFiles([photo.storageKey]);
  return { status: 200, body: { ok: true } };
}
