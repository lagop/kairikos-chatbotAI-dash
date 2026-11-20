import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { isUuid, requireCarteraPortal } from '@/lib/cartera/portal-auth';
import { deleteHome, deleteHomeFiles, loadHomeForPanel, saveHome } from '@/lib/cartera/homes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET    /api/portal/cartera/casas/[id] — la ficha con sus fotos.
 * PATCH  /api/portal/cartera/casas/[id]   body: { status?, data }
 * DELETE /api/portal/cartera/casas/[id] — solo un borrador nunca publicado.
 *
 * Cartera. `data` es la casa en el formato de la web, la que el formulario
 * tiene en pantalla. Se guarda siempre, aunque no valide: lo que falla vuelve
 * en `errors` y la casa no sale en el feed hasta corregirlo. La referencia,
 * las direcciones y el historial de precios los pone el portal
 * (lib/cartera/home-rules.ts): lo que llegue de esos campos se ignora.
 */
const PatchSchema = z
  .object({
    status: z.string().max(20).optional(),
    data: z.record(z.unknown()),
  })
  .strict();

const ERROR_STATUS: Record<string, number> = { not_found: 404, invalid_status: 400, published_to_draft: 409, too_large: 413, not_a_draft: 409 };

async function homeId(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  return isUuid(id) ? id.toLowerCase() : null;
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const ctx = await requireCarteraPortal('read');
  if (!ctx.ok) return ctx.response;
  const id = await homeId(props);
  const home = id ? await loadHomeForPanel(prisma, ctx.site.id, id) : null;
  if (!home) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({ home, readOnly: ctx.readOnly });
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const ctx = await requireCarteraPortal('write');
  if (!ctx.ok) return ctx.response;
  const id = await homeId(props);
  if (!id) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const body = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  const r = await prisma.$transaction((tx) => saveHome(tx, ctx.site, id, body.data, ctx.actor));
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: ERROR_STATUS[r.error] ?? 400 });
  return NextResponse.json(r);
}

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const ctx = await requireCarteraPortal('write');
  if (!ctx.ok) return ctx.response;
  const id = await homeId(props);
  if (!id) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const r = await prisma.$transaction((tx) => deleteHome(tx, ctx.site, id, ctx.actor));
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: ERROR_STATUS[r.error] ?? 400 });
  // Los ficheros, después de confirmar el borrado de las filas.
  await deleteHomeFiles(r.storageKeys);
  return NextResponse.json({ ok: true });
}
