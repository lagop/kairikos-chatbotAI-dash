import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { loadSectorStats, buildSectorStatsCsv } from '@/lib/sector-stats';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * A10 — GET /api/admin/portal/sector-stats
 *
 * Las estadísticas de mercado en CSV: lo que han visto todos los barridos,
 * agregado por sector y zona. Es el material de los estudios con datos
 * propios que pide el plan ("el 62 % de las peluquerías de Las Palmas no
 * tiene web propia").
 *
 * De operador, aunque lo que sale sea anónimo: es una agregación a través de
 * TODOS los clientes, y esa vista no le corresponde a ninguno de ellos.
 *
 * El filtro de grupos pequeños (MIN_GROUP_SIZE) va en el lib, no aquí: es una
 * regla del dato, no de esta ruta, y tiene que valer igual el día que estos
 * números se enseñen en otro sitio.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const rows = await loadSectorStats(prisma);

  const wantsJson = new URL(req.url).searchParams.get('format') === 'json';
  if (wantsJson) return NextResponse.json({ ok: true, rows });

  const fecha = new Date().toISOString().slice(0, 10);
  return new NextResponse(buildSectorStatsCsv(rows), {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="kairikos-mercado-${fecha}.csv"`,
      'cache-control': 'private, no-store',
    },
  });
}
