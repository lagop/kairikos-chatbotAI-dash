import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { logError } from '@/lib/observability';
import { parseSiteContent } from '@/lib/site-content';
import { resolveSeoWebsite } from '@/lib/website-seo-publish';
import { applyMetaProposals } from '@/lib/website-meta';
import { publishWebsite } from '@/lib/website-publish';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// =============================================================================
// Webs con IA, entrega 6 (27/10/2026) — POST /api/portal/seo/website-meta/apply
//
// El clic: guarda en su web los títulos y descripciones que el cliente ha
// revisado (y quizá retocado) y la vuelve a publicar. Lo que llega es lo que
// él aceptó, no lo que propuso la IA: si lo cambió, manda lo suyo. Si la web
// no se puede publicar ahora (datos de ejemplo, datos legales), se guarda
// igual y se dice por qué: saldrá con la siguiente publicación.
// =============================================================================

const BodySchema = z.object({
  clientProductId: z.string().uuid().optional(),
  paginas: z
    .array(z.object({ ruta: z.string().max(120), metaTitulo: z.string().max(70), metaDescripcion: z.string().max(160) }))
    .min(1)
    .max(20),
});

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session.hasClientAccess) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  const resolved = await resolveClientFromSession();
  if (!resolved) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  try {
    const ctx = await resolveSeoWebsite(prisma, resolved.clientId, body.data.clientProductId ?? null);
    if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
    const { content, changed } = applyMetaProposals(ctx.content, body.data.paginas);
    const valid = parseSiteContent(content);
    if (!valid.ok) return NextResponse.json({ error: 'invalid_content' }, { status: 400 });
    if (changed.length) {
      await prisma.$transaction(async (tx) => {
        await tx.clientWebsite.update({ where: { id: ctx.website.id }, data: { content: valid.content as unknown as object } });
        await tx.clientWebsiteAudit.create({
          data: {
            websiteId: ctx.website.id,
            clientId: resolved.clientId,
            tenantId: ctx.website.tenantId,
            action: 'meta_applied',
            after: { paginas: changed },
            actorType: 'client',
            actorEmail: `client:${resolved.clientId}`,
          },
        });
      });
    }
    const published = await publishWebsite(prisma, ctx.website.id, { type: 'client', email: `client:${resolved.clientId}` });
    return NextResponse.json({ ok: true, cambiadas: changed, publicada: published.ok, errorPublicacion: published.ok ? null : published.error });
  } catch (err) {
    logError('seo_website_meta.apply_failed', err, { clientId: resolved.clientId });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
