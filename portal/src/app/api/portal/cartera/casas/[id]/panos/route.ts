import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { isUuid, requireCarteraPortal } from '@/lib/cartera/portal-auth';
import { findOwnedHome } from '@/lib/cartera/homes';
import { deleteHomePano, reorderHomePanos, uploadHomePano } from '@/lib/cartera/photo-actions';
import { MAX_PANOS_PER_HOME } from '@/lib/cartera/photos';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST   /api/portal/cartera/casas/[id]/panos   multipart, campo «archivo»
 * PATCH  /api/portal/cartera/casas/[id]/panos   { order: [panoId…] }
 * DELETE /api/portal/cartera/casas/[id]/panos   { panoId }
 *
 * Cartera — las fotos 360° de una casa (25/11/2026), como las fotos de
 * ../fotos/route.ts: el navegador las reduce a 4.096 px de ancho y las vuelve
 * a codificar (sin EXIF ni GPS); aquí se comprueba el tipo por los primeros
 * bytes, que sean 2:1 (equirrectangulares), hasta 6 MB y 30 por casa.
 */
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const PatchSchema = z.object({ order: z.array(uuid).max(MAX_PANOS_PER_HOME) }).strict();
const DeleteSchema = z.object({ panoId: uuid }).strict();

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
  const r = await uploadHomePano(prisma, ctx.site, home, req, ctx.actor);
  return NextResponse.json(r.body, { status: r.status });
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { ctx, home } = await ownedHome(props);
  if (!ctx.ok) return ctx.response;
  if (!home) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const body = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  const r = await reorderHomePanos(prisma, ctx.site, home, body.data.order.map((x) => x.toLowerCase()), ctx.actor);
  return NextResponse.json(r.body, { status: r.status });
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { ctx, home } = await ownedHome(props);
  if (!ctx.ok) return ctx.response;
  if (!home) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const body = DeleteSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  const r = await deleteHomePano(prisma, ctx.site, home, body.data.panoId.toLowerCase(), ctx.actor);
  return NextResponse.json(r.body, { status: r.status });
}
