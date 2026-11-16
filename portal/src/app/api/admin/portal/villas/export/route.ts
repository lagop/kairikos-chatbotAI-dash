import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { logError } from '@/lib/observability';
import { VILLAS_PRODUCT_CODE } from '@/lib/villas/rental';
import { buildVillaExport, exportResponse, parseExportKind } from '@/lib/villas/export';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/admin/portal/villas/export?clientId=…&tipo=solicitudes|villas|auditoria
 * GET /api/admin/portal/villas/export?clientId=…&tipo=ics&villa=<id>
 *
 * Reserva propia para villas — el operador saca los datos de un cliente para
 * entregárselos (baja, petición de soporte, un dueño que no consigue entrar).
 * Sirve en cualquier estado mientras la VillaRental exista: el operador no
 * depende del plazo de gracia, depende de que no se haya purgado todavía.
 * Queda auditado con el operador como autor.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const clientId = req.nextUrl.searchParams.get('clientId')?.trim() ?? '';
  if (!clientId || clientId.length > 64) return NextResponse.json({ error: 'invalid_client' }, { status: 400 });
  const kind = parseExportKind(req.nextUrl.searchParams.get('tipo'));
  if (!kind) return NextResponse.json({ error: 'invalid_kind' }, { status: 400 });

  const rental = await prisma.villaRental.findFirst({
    where: { clientId, clientProduct: { product: { code: VILLAS_PRODUCT_CODE } } },
    select: { id: true, clientId: true, businessName: true },
  });
  if (!rental) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  try {
    const result = await buildVillaExport(prisma, rental, kind, {
      villaId: req.nextUrl.searchParams.get('villa'),
      actor: `operator:${auth.operatorId}`,
    });
    return exportResponse(result);
  } catch (err) {
    logError('villas.export.admin', err, { clientId, kind }, 'error');
    return NextResponse.json({ error: 'export_failed' }, { status: 500 });
  }
}
