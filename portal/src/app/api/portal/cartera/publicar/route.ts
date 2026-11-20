import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireCarteraPortal } from '@/lib/cartera/portal-auth';
import { launchPublication } from '@/lib/cartera/publish';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/portal/cartera/publicar   body: { confirm?: true }
 *
 * Cartera — «Publicar ahora». Se salta los 15 minutos entre publicaciones,
 * nunca lo de «ninguna en curso». Si la publicación va a retirar muchas casas
 * de la web (salvaguarda de vaciado), responde 409 `confirm_removal` con
 * cuántas; el panel pregunta y repite con `confirm: true`.
 */
const BodySchema = z.object({ confirm: z.literal(true).optional() }).strict();

const STATUS: Record<string, number> = {
  not_configured: 409,
  not_active: 409,
  in_progress: 409,
  nothing_pending: 409,
  confirm_removal: 409,
  dispatch_failed: 502,
  not_found: 404,
};

export async function POST(req: NextRequest) {
  const ctx = await requireCarteraPortal('write');
  if (!ctx.ok) return ctx.response;
  const body = BodySchema.safeParse((await req.json().catch(() => ({}))) ?? {});
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  const r = await launchPublication(prisma, ctx.site.id, { mode: 'manual', confirmRemoval: body.data.confirm === true, actor: ctx.actor });
  if (r.ok) return NextResponse.json({ ok: true, buildId: r.buildId, homeCount: r.homeCount }, { status: 202 });
  return NextResponse.json(r, { status: STATUS[r.error] ?? 409 });
}
