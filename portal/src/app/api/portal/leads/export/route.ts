import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { hasLeadsInboxAccess } from '@/lib/leads';
import { buildCsv, loadLeadsForExport, exportFilename } from '@/lib/lead-export';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Fase 4 — GET /api/portal/leads/export
 *
 * Los leads del cliente en CSV.
 *
 * GET y no POST porque es una descarga: así el navegador la trata como
 * tal y el enlace funciona desde un `<a download>` sin JavaScript.
 *
 * El acceso se comprueba con hasLeadsInboxAccess ('leads' O 'prospecting'),
 * el mismo helper que usa el buzón: quien puede ver un lead en pantalla
 * puede llevárselo, y tener dos definiciones distintas de eso es cómo
 * acaban divergiendo.
 */
export async function GET(_req: NextRequest) {
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
  if (!(await hasLeadsInboxAccess(prisma, resolved.clientId))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  try {
    const rows = await loadLeadsForExport(prisma, resolved.clientId);

    // El BOM delante es lo que hace que Excel en Windows abra los acentos
    // bien. Sin él, «Peluquería» sale «PeluquerÃ­a» y el cliente cree que
    // le hemos dado un fichero roto — y este CSV se abre en Excel, no en
    // un editor de texto.
    const csv = `﻿${buildCsv(rows)}`;

    return new NextResponse(csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${exportFilename()}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    logError('portal.leads_export.failed', err, { clientId: resolved.clientId }, 'error');
    return NextResponse.json({ error: 'export_failed' }, { status: 500 });
  }
}
