import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireCarteraPortal } from '@/lib/cartera/portal-auth';
import { listHomesForPanel, siteAgents } from '@/lib/cartera/homes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/portal/cartera — el sitio de la agencia, sus casas y la última
 * publicación. También en la gracia de una baja (`readOnly: true`).
 *
 * Nunca devuelve el token del feed ni nada del secreto de publicación: los ve
 * solo el operador, una vez, al generarlos.
 */
export async function GET() {
  const ctx = await requireCarteraPortal('read');
  if (!ctx.ok) return ctx.response;
  const [homes, lastBuild] = await Promise.all([
    listHomesForPanel(prisma, ctx.site.id),
    prisma.carteraBuild.findFirst({
      where: { siteId: ctx.site.id },
      orderBy: { dispatchedAt: 'desc' },
      select: { status: true, dispatchedAt: true, finishedAt: true, homeCount: true, runUrl: true },
    }),
  ]);
  return NextResponse.json({
    site: {
      siteUrl: ctx.site.siteUrl,
      salePrefix: ctx.site.salePrefix,
      rentPrefix: ctx.site.rentPrefix,
      agents: siteAgents(ctx.site),
      pendingSince: ctx.site.pendingSince?.toISOString() ?? null,
      readOnly: ctx.readOnly,
    },
    homes,
    lastBuild,
  });
}
