import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { isUuid, requireCarteraPortal } from '@/lib/cartera/portal-auth';
import { findOwnedHome } from '@/lib/cartera/homes';
import { deleteHomePhoto, reorderHomePhotos, setHomePhotoAlt, uploadHomePhoto } from '@/lib/cartera/photo-actions';
import { MAX_PHOTOS_PER_HOME } from '@/lib/cartera/photos';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST   /api/portal/cartera/casas/[id]/fotos   multipart, campo «archivo»
 * PATCH  /api/portal/cartera/casas/[id]/fotos   { order: [photoId…] } | { photoId, alt: { es?, en?, de? } }
 * DELETE /api/portal/cartera/casas/[id]/fotos   { photoId }
 *
 * Cartera — las fotos de una casa (lib/cartera/photo-actions.ts). El
 * navegador las reduce a 2.400 px y las vuelve a codificar antes de subirlas,
 * lo que quita EXIF y GPS; aquí se comprueba el tipo por los primeros bytes
 * (JPEG, PNG o WebP), hasta 3 MB y 40 por casa. La primera es la portada.
 */
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const PatchSchema = z.union([
  z.object({ order: z.array(uuid).max(MAX_PHOTOS_PER_HOME) }).strict(),
  z.object({ photoId: uuid, alt: z.object({ es: z.string().max(300).optional(), en: z.string().max(300).optional(), de: z.string().max(300).optional() }).strict() }).strict(),
]);
const DeleteSchema = z.object({ photoId: uuid }).strict();

async function ownedHome(props: { params: Promise<{ id: string }> }) {
  const ctx = await requireCarteraPortal('write');
  if (!ctx.ok) return { ctx, home: null };
  const { id } = await props.params;
  const home = isUuid(id) ? await findOwnedHome(prisma, ctx.site.id, id.toLowerCase()) : null;
  return { ctx, home };
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { ctx, home } = await ownedHome(props);
  if (!ctx.ok) return ctx.response;
  if (!home) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const r = await uploadHomePhoto(prisma, ctx.site, home, req, ctx.actor);
  return NextResponse.json(r.body, { status: r.status });
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { ctx, home } = await ownedHome(props);
  if (!ctx.ok) return ctx.response;
  if (!home) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const body = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  const r =
    'order' in body.data
      ? await reorderHomePhotos(prisma, ctx.site, home, body.data.order.map((x) => x.toLowerCase()), ctx.actor)
      : await setHomePhotoAlt(prisma, ctx.site, home, body.data.photoId.toLowerCase(), body.data.alt, ctx.actor);
  return NextResponse.json(r.body, { status: r.status });
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { ctx, home } = await ownedHome(props);
  if (!ctx.ok) return ctx.response;
  if (!home) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const body = DeleteSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  const r = await deleteHomePhoto(prisma, ctx.site, home, body.data.photoId.toLowerCase(), ctx.actor);
  return NextResponse.json(r.body, { status: r.status });
}
