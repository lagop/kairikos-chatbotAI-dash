import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Canales Fase 4 — PATCH /api/portal/channels/web
//
// Updates appearance only (primaryColor/position) — activation status
// is handled by enable/disable, not this route, so a color change can
// never accidentally flip a disabled widget back on. No tier gate here:
// once a ChatWebEmbed row exists, editing its color/position is not a
// "connect a new channel" action.
// =============================================================================

const BodySchema = z.object({
  primaryColor: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'invalid_hex_color'),
  position: z.enum(['bottom-right', 'bottom-left']),
});

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const resolved = await resolveClientFromSession();
  if (!resolved) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  const embed = await prisma.chatWebEmbed.findFirst({ where: { clientId: resolved.clientId } });
  if (!embed) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const updated = await prisma.chatWebEmbed.update({
    where: { id: embed.id },
    data: { primaryColor: body.data.primaryColor, position: body.data.position },
  });

  return NextResponse.json({ ok: true, primaryColor: updated.primaryColor, position: updated.position });
}
