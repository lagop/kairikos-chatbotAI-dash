import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { logError } from '@/lib/observability';
import { resolveSeoWebsite } from '@/lib/website-seo-publish';
import { pageSummaries } from '@/lib/website-meta';
import { proposeWebsiteMeta } from '@/lib/website-meta-ai';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// =============================================================================
// Webs con IA, entrega 6 (27/10/2026) — POST /api/portal/seo/website-meta
//
// PROPONE el título y la descripción para Google de cada página de su web de
// Kairikos. No guarda nada: lo que el cliente acepte va por
// /api/portal/seo/website-meta/apply. Ver website-meta-ai.ts.
// =============================================================================

const BodySchema = z.object({ clientProductId: z.string().uuid().optional() });

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session.hasClientAccess) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  const resolved = await resolveClientFromSession();
  if (!resolved) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  try {
    const ctx = await resolveSeoWebsite(prisma, resolved.clientId, body.data.clientProductId ?? null);
    if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
    const keywords = await prisma.seoTargetKeyword.findMany({
      where: { profileId: ctx.profileId },
      select: { keyword: true },
      take: 15,
    });
    const pages = pageSummaries(ctx.content);
    const result = await proposeWebsiteMeta({
      businessName: ctx.website.businessName,
      city: ctx.website.city,
      businessDescription: ctx.businessDescription,
      keywords: keywords.map((k) => k.keyword),
      pages,
    });
    if (!result.ok) {
      logError('seo_website_meta.ai_failed', new Error(result.error), { clientId: resolved.clientId }, 'warn');
      return NextResponse.json({ error: 'ai_failed' }, { status: 502 });
    }
    if ('skipped' in result) return NextResponse.json({ error: 'ai_not_configured' }, { status: 503 });
    return NextResponse.json({
      ok: true,
      paginas: pages.map((p) => ({ ruta: p.ruta, titulo: p.titulo, metaTitulo: p.metaTituloActual, metaDescripcion: p.metaDescripcionActual })),
      propuestas: result.proposals,
    });
  } catch (err) {
    logError('seo_website_meta.propose_failed', err, { clientId: resolved.clientId });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
