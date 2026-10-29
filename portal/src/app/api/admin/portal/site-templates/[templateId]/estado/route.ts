import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { logError } from '@/lib/observability';
import { restoreSiteTemplateVersion, setSiteTemplateState } from '@/lib/site-template-jobs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Webs con IA, entrega 2 (27/10/2026) — POST /api/admin/portal/site-templates/[id]/estado
//
// Aprobar una plantilla lista, retirar una aprobada (las webs que ya la usan
// siguen igual; deja de ofrecerse para webs nuevas) o pedir otra ronda de
// comprobación a una que falló. Las transiciones válidas viven en
// site-template-jobs.ts, no aquí.
//
// 29/10/2026: aprobar una CORRECCIÓN la aplica a su original; «descartar»
// cierra una que no se va a aplicar, y «restaurar» devuelve una aprobada a una
// de sus versiones anteriores (SiteTemplateVersion).
// =============================================================================

const BodySchema = z.discriminatedUnion('accion', [
  z.object({ accion: z.enum(['aprobar', 'retirar', 'reintentar', 'descartar']) }),
  z.object({ accion: z.literal('restaurar'), version: z.string().uuid() }),
]);

export async function POST(req: NextRequest, props: { params: Promise<{ templateId: string }> }) {
  const params = await props.params;
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  try {
    const operator = await prisma.operator.findUnique({ where: { id: auth.operatorId }, select: { email: true } });
    const actor = operator?.email ?? null;
    const result =
      body.data.accion === 'restaurar'
        ? await restoreSiteTemplateVersion(prisma, params.templateId, body.data.version, actor)
        : await setSiteTemplateState(prisma, params.templateId, body.data.accion, actor);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.error === 'not_found' ? 404 : 409 });
    return NextResponse.json(result);
  } catch (err) {
    logError('site_templates.state_failed', err, { templateId: params.templateId });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
