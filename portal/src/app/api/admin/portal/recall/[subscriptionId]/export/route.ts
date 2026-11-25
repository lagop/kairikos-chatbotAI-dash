import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { logError } from '@/lib/observability';
import { parseExportFormat, recordClientDataAudit } from '@/lib/client-data-audit';
import { loadRecallExportScope, recallExportResponse } from '@/lib/recall-export';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/admin/portal/recall/[subscriptionId]/export?formato=csv|json
 *
 * RGPD (25/11/2026, PR 2 del plan del encargo): el operador saca los
 * registros de llamadas de una línea para entregárselos al cliente (baja,
 * soporte). Mismo fichero que la ruta del cliente, en cualquier estado de la
 * suscripción mientras exista. Sesión de operador real; la descarga queda en
 * ClientDataAudit con el operador como autor, antes de mandar nada.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ subscriptionId: string }> }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const { subscriptionId } = await props.params;
  if (!/^[0-9a-f-]{36}$/i.test(subscriptionId)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const format = parseExportFormat(req.nextUrl.searchParams.get('formato') ?? req.nextUrl.searchParams.get('format'));
  if (!format) return NextResponse.json({ error: 'invalid_format' }, { status: 400 });

  let scope;
  try {
    scope = await loadRecallExportScope(prisma, subscriptionId.toLowerCase());
    if (!scope) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    await recordClientDataAudit(prisma, {
      clientId: scope.clientId,
      clientProductId: scope.clientProductId,
      tenantId: scope.tenantId,
      productCode: 'recall',
      action: 'exported',
      actor: `operator:${auth.operatorId}`,
      metadata: { format, count: scope.count },
    });
  } catch (err) {
    logError('admin.recall_export.failed', err, { subscriptionId }, 'error');
    return NextResponse.json({ error: 'export_failed' }, { status: 500 });
  }

  return recallExportResponse(prisma, scope, format, (err) =>
    logError('admin.recall_export.stream', err, { subscriptionId }, 'error'),
  );
}
