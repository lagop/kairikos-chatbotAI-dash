import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { logError } from '@/lib/observability';
import { buildSiteContentFromDraft } from '@/lib/site-content-ai';
import { SITE_TEMPLATE_BASE } from '@/lib/site-template-base';
import { templateIconIds } from '@/lib/web-draft-design';
import type { WebDraftCopy } from '@/lib/web-draft-ai';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Webs con IA, entrega 4 (27/10/2026) — POST /api/admin/portal/websites/[id]/design
//
// Lo que el cliente NO puede tocar de su web, porque es estructura:
// - «convertir»: pasar una web de las de antes (copy + plantilla de código)
//   al contenido v2, con la plantilla base. Cambia su aspecto, así que es
//   decisión del operador y no ocurre sola en ningún despliegue.
// - «plantilla»: ponerle una plantilla APROBADA de la biblioteca, o la base
//   (templateId null). Solo a webs con contenido v2.
// Ninguna de las dos publica: el operador o el cliente lo hacen después,
// viendo antes la vista previa.
// =============================================================================

const BodySchema = z.discriminatedUnion('accion', [
  z.object({ accion: z.literal('convertir') }),
  z.object({ accion: z.literal('plantilla'), templateId: z.string().uuid().nullable() }),
]);

export async function POST(req: NextRequest, props: { params: Promise<{ websiteId: string }> }) {
  const params = await props.params;
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  const website = await prisma.clientWebsite.findUnique({
    where: { id: params.websiteId },
    select: { id: true, clientId: true, tenantId: true, copy: true, content: true, templateId: true },
  });
  if (!website) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const operator = await prisma.operator.findUnique({ where: { id: auth.operatorId }, select: { email: true } });

  let data: { content?: object; templateId?: string | null };
  let after: Record<string, unknown>;
  if (body.data.accion === 'convertir') {
    if (website.content != null) return NextResponse.json({ error: 'already_v2' }, { status: 409 });
    const content = buildSiteContentFromDraft(website.copy as unknown as WebDraftCopy, null, templateIconIds(SITE_TEMPLATE_BASE.marco));
    data = { content: content as unknown as object, templateId: null };
    after = { convertida: true, plantilla: 'base' };
  } else {
    if (website.content == null) return NextResponse.json({ error: 'not_v2' }, { status: 409 });
    if (body.data.templateId) {
      const template = await prisma.siteTemplate.findUnique({ where: { id: body.data.templateId }, select: { estado: true } });
      if (!template || template.estado !== 'aprobada') return NextResponse.json({ error: 'template_not_approved' }, { status: 409 });
    }
    data = { templateId: body.data.templateId };
    after = { templateId: body.data.templateId, antes: website.templateId };
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.clientWebsite.update({ where: { id: website.id }, data });
      await tx.clientWebsiteAudit.create({
        data: {
          websiteId: website.id,
          clientId: website.clientId,
          tenantId: website.tenantId,
          action: 'design_updated',
          after: after as object,
          actorType: 'operator',
          actorOperatorId: auth.operatorId,
          actorEmail: operator?.email ?? null,
        },
      });
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    logError('client_website.design_update_failed', err, { websiteId: website.id });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
