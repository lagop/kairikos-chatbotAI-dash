import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { logError } from '@/lib/observability';
import { auditExport, exportResponse, planCarteraExport } from '@/lib/cartera/export';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/admin/portal/cartera/[siteId]/exportar — el operador saca el ZIP de
 * una agencia para entregárselo (baja, soporte, una agencia que no consigue
 * entrar). Como en villas: sirve en cualquier estado mientras el sitio exista,
 * es decir, hasta la purga. Queda auditado con el operador como autor.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ siteId: string }> }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  const { siteId } = await props.params;
  if (!/^[0-9a-f-]{36}$/i.test(siteId)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const site = await prisma.carteraSite.findUnique({ where: { id: siteId.toLowerCase() }, select: { id: true, clientId: true } });
  if (!site) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const planned = await planCarteraExport(prisma, site);
  if (!planned.ok) {
    logError('cartera.export', new Error(`${planned.error}: ${planned.detail}`), { siteId: site.id }, 'error');
    return NextResponse.json({ error: 'export_failed', reason: planned.error, detail: planned.detail }, { status: 500 });
  }
  await auditExport(prisma, site, planned.plan, `operator:${auth.operatorId}`);
  return exportResponse(planned.plan, (err) => logError('cartera.export_stream', err, { siteId: site.id }, 'error'));
}
