import 'server-only';
import type { Prisma, PrismaClient } from '@prisma/client';
import { auditCartera } from './site';
import { markPending } from './homes';
import { isPublishable } from './feed';
import { MAX_PANO_BYTES, PHOTO_ERROR_STATUS, cleanAlt, isSamePhotoSet, readPhotoUpload, removePhotoFiles, storeHomePano, storeHomePhoto } from './photos';
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

// --- Fotos 360° (25/11/2026) ---------------------------------------------------
// Lo mismo que las fotos, en su tabla (CarteraPano) y sin texto alternativo.
// La auditoría usa la entidad 'photo' con acciones propias (pano_*): es un
// fichero del mismo volumen y así no hace falta otro valor de entity.

export async function uploadHomePano(prisma: PrismaClient, site: Site, home: Home, req: Request, actor: string): Promise<Result> {
  const file = await readPhotoUpload(req, MAX_PANO_BYTES);
  if (!file.ok) return { status: file.status, body: { error: file.error } };
  try {
    const r = await storeHomePano(prisma, home, file.buf);
    if (!r.ok) return { status: PHOTO_ERROR_STATUS[r.error] ?? 400, body: { error: r.error } };
    await prisma.$transaction(async (tx) => {
      await auditCartera(tx, {
        siteId: site.id,
        clientId: site.clientId,
        entity: 'photo',
        entityId: r.pano.id,
        action: 'pano_added',
        actor,
        metadata: { ref: home.ref, width: r.pano.width, height: r.pano.height, bytes: r.pano.bytes },
      });
      if (isPublishable(home)) await markPending(tx, site.id);
    });
    return { status: 200, body: { ok: true, pano: r.pano } };
  } catch (err) {
    logError('cartera.pano_upload', err, { homeId: home.id });
    return { status: 500, body: { error: 'internal_error' } };
  }
}

export async function reorderHomePanos(prisma: PrismaClient, site: Site, home: Home, order: string[], actor: string): Promise<Result> {
  const current = await prisma.carteraPano.findMany({ where: { homeId: home.id }, select: { id: true } });
  if (!isSamePhotoSet(current.map((p) => p.id), order)) return { status: 400, body: { error: 'invalid_order' } };
  await prisma.$transaction(async (tx) => {
    for (const [position, id] of order.entries()) await tx.carteraPano.update({ where: { id }, data: { position } });
    await auditCartera(tx, { siteId: site.id, clientId: site.clientId, entity: 'home', entityId: home.id, action: 'panos_reordered', actor, metadata: { ref: home.ref, count: order.length } });
    if (isPublishable(home)) await markPending(tx, site.id);
  });
  return { status: 200, body: { ok: true } };
}

export async function deleteHomePano(prisma: PrismaClient, site: Site, home: Home, panoId: string, actor: string): Promise<Result> {
  const pano = await prisma.carteraPano.findFirst({ where: { id: panoId, homeId: home.id }, select: { id: true, storageKey: true } });
  if (!pano) return { status: 404, body: { error: 'not_found' } };
  await prisma.$transaction(async (tx) => {
    await tx.carteraPano.delete({ where: { id: pano.id } });
    const rest = await tx.carteraPano.findMany({ where: { homeId: home.id }, orderBy: { position: 'asc' }, select: { id: true, position: true } });
    for (const [position, p] of rest.entries()) if (p.position !== position) await tx.carteraPano.update({ where: { id: p.id }, data: { position } });
    await auditCartera(tx, { siteId: site.id, clientId: site.clientId, entity: 'photo', entityId: pano.id, action: 'pano_removed', actor, metadata: { ref: home.ref } });
    if (isPublishable(home)) await markPending(tx, site.id);
  });
  await removePhotoFiles([pano.storageKey]);
  return { status: 200, body: { ok: true } };
}
