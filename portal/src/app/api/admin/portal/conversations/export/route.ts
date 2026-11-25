import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { logError } from '@/lib/observability';
import { parseExportFormat, recordClientDataAudit } from '@/lib/client-data-audit';
import { chatbotExportResponse, loadChatbotExportScope } from '@/lib/chatbot-export';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/admin/portal/conversations/export?clientId=…&formato=csv|json
 *
 * RGPD (25/11/2026, PR 1 del plan del encargo): el operador saca las
 * conversaciones de un cliente para entregárselas (baja, petición de
 * soporte, un cliente que no consigue entrar). Mismo fichero que la ruta del
 * cliente (lib/chatbot-export.ts) y en cualquier estado del contrato
 * mientras las conversaciones existan, como villas y cartera.
 *
 * Sesión de operador real (authenticateAdminRequest): la descarga queda en
 * ClientDataAudit con el operador como autor, antes de mandar nada.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const clientId = req.nextUrl.searchParams.get('clientId')?.trim() ?? '';
  if (!clientId || clientId.length > 64) return NextResponse.json({ error: 'invalid_client' }, { status: 400 });
  const format = parseExportFormat(req.nextUrl.searchParams.get('formato') ?? req.nextUrl.searchParams.get('format'));
  if (!format) return NextResponse.json({ error: 'invalid_format' }, { status: 400 });

  try {
    const scope = await loadChatbotExportScope(prisma, clientId);
    if (!scope) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    await recordClientDataAudit(prisma, {
      clientId,
      tenantId: scope.tenantId,
      productCode: 'chatbot',
      action: 'exported',
      actor: `operator:${auth.operatorId}`,
      metadata: { format, count: scope.count },
    });
  } catch (err) {
    logError('admin.conversations_export.failed', err, { clientId }, 'error');
    return NextResponse.json({ error: 'export_failed' }, { status: 500 });
  }

  return chatbotExportResponse(prisma, clientId, format, (err) =>
    logError('admin.conversations_export.stream', err, { clientId }, 'error'),
  );
}
