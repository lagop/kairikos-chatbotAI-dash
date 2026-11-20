import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { applySiteSettings, siteSettingsSchema } from '@/lib/cartera/site-settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * PATCH /api/admin/portal/cartera/[siteId]
 *   body: { githubRepo?, workflowFile?, siteUrl?, salePrefix?, rentPrefix?,
 *           agents?, regenerateFeedToken?: true, regenerateBuildSecret?: true }
 *
 * Cartera — lo que configura el operador en el sitio de una agencia. Si se
 * pide regenerar, la respuesta trae `feedToken` y/o `buildSecret` en claro:
 * es la ÚNICA vez que se enseñan (el secreto queda solo como hash). Van a los
 * secretos del repositorio de GitHub de la web, nunca a su HTML.
 *
 * La lógica vive en lib/cartera/site-settings.ts.
 */
export async function PATCH(req: NextRequest, props: { params: Promise<{ siteId: string }> }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  const { siteId } = await props.params;
  if (!/^[0-9a-f-]{36}$/i.test(siteId)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const body = siteSettingsSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body', issues: body.error.flatten().fieldErrors }, { status: 400 });

  const result = await prisma.$transaction(async (tx) => {
    const site = await tx.carteraSite.findUnique({ where: { id: siteId }, select: { id: true, clientId: true, salePrefix: true, rentPrefix: true } });
    if (!site) return null;
    return applySiteSettings(tx, site, body.data, `operator:${auth.operatorId}`);
  });
  if (!result) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
}
