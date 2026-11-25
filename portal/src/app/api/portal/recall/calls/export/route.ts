import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { resolveClientTarget } from '@/lib/recall-owner-settings-auth';
import { logError } from '@/lib/observability';
import { parseExportFormat, recordClientDataAudit } from '@/lib/client-data-audit';
import { loadRecallExportScope, recallExportResponse } from '@/lib/recall-export';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/portal/recall/calls/export?formato=csv|json[&clientProductId=…]
 *
 * RGPD (25/11/2026, PR 2 del plan del encargo): los registros de llamadas de
 * una línea, en CSV o JSON, sin la grabación ni su URL (lib/recall-export.ts).
 *
 * La línea la resuelve resolveClientTarget, la misma que usan el WhatsApp del
 * dueño y la locución: el cliente sale de la sesión y `clientProductId` solo
 * FILTRA sus propias suscripciones (el de otro da 404); con varias líneas y
 * sin id, 409 en vez de elegir. No mira el estado de la suscripción, así que
 * con el servicio pausado o cancelado también exporta: en la gracia de una
 * baja es cuando más hace falta.
 *
 * Cada descarga deja una fila en ClientDataAudit (producto 'recall', con el
 * recuento) antes de mandar el fichero. Si la auditoría falla, no hay fichero.
 */
export async function GET(req: NextRequest) {
  const format = parseExportFormat(req.nextUrl.searchParams.get('formato') ?? req.nextUrl.searchParams.get('format'));
  const clientProductId = req.nextUrl.searchParams.get('clientProductId')?.trim() || null;
  // La columna es uuid: un valor que no lo es haría fallar la consulta con
  // un 500 en vez de decir que la petición está mal.
  if (clientProductId && !UUID_RE.test(clientProductId)) {
    return NextResponse.json({ error: 'invalid_line' }, { status: 400 });
  }

  const target = await resolveClientTarget(clientProductId);
  if (target instanceof Response) return target;
  if (target.actor.type !== 'client') return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!format) return NextResponse.json({ error: 'invalid_format' }, { status: 400 });

  const clientId = target.actor.clientId;
  let scope;
  try {
    scope = await loadRecallExportScope(prisma, target.subscriptionId);
    // resolveClientTarget ya filtró por cliente; esto es la segunda cerradura.
    if (!scope || scope.clientId !== clientId) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    await recordClientDataAudit(prisma, {
      clientId,
      clientProductId: scope.clientProductId,
      tenantId: scope.tenantId,
      productCode: 'recall',
      action: 'exported',
      actor: `client:${clientId}`,
      metadata: { format, count: scope.count },
    });
  } catch (err) {
    logError('portal.recall_export.failed', err, { clientId }, 'error');
    return NextResponse.json({ error: 'export_failed' }, { status: 500 });
  }

  const subscriptionId = scope.subscriptionId;
  return recallExportResponse(prisma, scope, format, (err) =>
    logError('portal.recall_export.stream', err, { clientId, subscriptionId }, 'error'),
  );
}
