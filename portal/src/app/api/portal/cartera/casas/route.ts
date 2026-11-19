import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireCarteraPortal } from '@/lib/cartera/portal-auth';
import { createHome } from '@/lib/cartera/homes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/portal/cartera/casas   body: { operation: 'venta' | 'alquiler' }
 *
 * Cartera — «Nueva casa»: un borrador vacío con su referencia (C-1xx venta,
 * A-2xx alquiler), que no cambia nunca. La operación tampoco: decide la
 * referencia y el formato. Lo demás se rellena en la ficha.
 */
const BodySchema = z.object({ operation: z.enum(['venta', 'alquiler']) }).strict();

export async function POST(req: NextRequest) {
  const ctx = await requireCarteraPortal('write');
  if (!ctx.ok) return ctx.response;
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  const r = await createHome(prisma, ctx.site, body.data.operation, ctx.actor);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 409 });
  return NextResponse.json({ ok: true, id: r.id, ref: r.ref }, { status: 201 });
}
