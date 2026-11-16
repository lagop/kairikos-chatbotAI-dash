import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { logError } from '@/lib/observability';
import { findRentalForOwner } from '@/lib/villas/rental';
import { buildVillaExport, exportResponse, parseExportKind } from '@/lib/villas/export';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/portal/villas/export?tipo=solicitudes|villas|auditoria
 * GET /api/portal/villas/export?tipo=ics&villa=<id>
 *
 * Reserva propia para villas — el dueño se lleva sus datos. Funciona con la
 * contratación activa, pausada y DADA DE BAJA dentro del plazo de gracia
 * (findRentalForOwner, lib/villas/exit-rules.ts): es la devolución de datos
 * al acabar el encargo (RGPD art. 28.3.g). GET para que un enlace con
 * `download` baste. El cliente sale de la sesión, nunca de la URL.
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session.hasClientAccess) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  const resolved = await resolveClientFromSession();
  if (!resolved || resolved.source !== 'database') return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const kind = parseExportKind(req.nextUrl.searchParams.get('tipo'));
  if (!kind) return NextResponse.json({ error: 'invalid_kind' }, { status: 400 });
  const owner = await findRentalForOwner(prisma, resolved.clientId);
  if (!owner) return NextResponse.json({ error: 'not_contracted' }, { status: 403 });

  try {
    const result = await buildVillaExport(prisma, owner.rental, kind, {
      villaId: req.nextUrl.searchParams.get('villa'),
      actor: `client:${resolved.clientId}`,
    });
    return exportResponse(result);
  } catch (err) {
    logError('villas.export.portal', err, { clientId: resolved.clientId, kind }, 'error');
    return NextResponse.json({ error: 'export_failed' }, { status: 500 });
  }
}
