import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { logError } from '@/lib/observability';
import { parseExportFormat, recordClientDataAudit } from '@/lib/client-data-audit';
import { chatbotExportResponse, loadChatbotExportScope } from '@/lib/chatbot-export';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/portal/conversations/export?formato=csv|json
 *
 * RGPD (25/11/2026, PR 1 del plan del encargo): todas las conversaciones del
 * chat del cliente, en CSV (una fila por turno) o JSON (una por
 * conversación). La lógica, en lib/chatbot-export.ts.
 *
 * El cliente sale SOLO de la sesión: aquí no se acepta ningún identificador
 * de cliente en la URL.
 *
 * NO exige el chatbot contratado y activo, a propósito: quien está en el
 * plazo de gracia de una baja, o con el producto cancelado, es justo quien
 * más necesita llevarse sus datos (cláusula 10 del contrato). Basta con que
 * tenga conversaciones o haya tenido alguna vez un chatbot; a quien nunca lo
 * tuvo, 403 — no hay nada suyo que exportar y un fichero vacío confunde.
 *
 * Cada descarga deja una fila en ClientDataAudit ANTES de empezar a mandar el
 * fichero, con el recuento y el formato (nunca el contenido). Si la
 * auditoría falla, no hay fichero.
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }
  const resolved = await resolveClientFromSession();
  if (!resolved || resolved.source !== 'database') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const format = parseExportFormat(req.nextUrl.searchParams.get('formato') ?? req.nextUrl.searchParams.get('format'));
  if (!format) return NextResponse.json({ error: 'invalid_format' }, { status: 400 });

  const clientId = resolved.clientId;
  try {
    const scope = await loadChatbotExportScope(prisma, clientId);
    if (!scope) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    if (scope.count === 0 && !scope.everContracted) {
      return NextResponse.json({ error: 'not_contracted' }, { status: 403 });
    }

    await recordClientDataAudit(prisma, {
      clientId,
      tenantId: scope.tenantId,
      productCode: 'chatbot',
      action: 'exported',
      actor: `client:${clientId}`,
      metadata: { format, count: scope.count },
    });
  } catch (err) {
    logError('portal.conversations_export.failed', err, { clientId }, 'error');
    return NextResponse.json({ error: 'export_failed' }, { status: 500 });
  }

  return chatbotExportResponse(prisma, clientId, format, (err) =>
    logError('portal.conversations_export.stream', err, { clientId }, 'error'),
  );
}
