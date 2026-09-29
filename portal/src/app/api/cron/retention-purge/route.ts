import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';
import { runRetentionPurge } from '@/lib/retention-purge';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// =============================================================================
// El borrado por plazo de conservación (ver src/lib/retention-purge.ts).
//
// Va en scripts/scheduler.sh, que lo llama cada cinco minutos: cada pasada
// solo busca lo que aún queda por hacer, así que es idempotente. El recuento
// de cada pasada sale en el cuerpo de la respuesta, y el scheduler escribe
// ese cuerpo en su log (`docker logs kairikos-portal-scheduler`): ese es el
// registro de cuánto se borra.
//
// Un fallo NO responde 200. El resto de ticks tratan sus trabajos como
// best-effort; este no, porque si deja de borrar, la política de privacidad
// deja de ser verdad, y un 500 al menos sale como FAILED en el log del
// scheduler en vez de pasar como un OK más.
// =============================================================================

export async function GET(req: NextRequest) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  try {
    const result = await runRetentionPurge(prisma, new Date());
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    logError('retention_purge.failed', err, {}, 'error');
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'unknown error' },
      { status: 500 },
    );
  }
}
