import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { sweepCartera } from '@/lib/cartera/publish';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Cartera — GET /api/cron/cartera-tick
 *
 * Pasa a «desconocida» lo que lleva 45 minutos sin noticias y publica lo
 * pendiente de cada sitio (lib/cartera/publish.ts, sweepCartera). La purga de
 * contactos (PR 5) y las bajas (PR 6) se añadirán al mismo barrido.
 *
 * Idempotente: el scheduler la llama cada 5 minutos y la lógica de «¿toca
 * ya?» vive en decideLaunch, no en la cadencia. Añadida a scripts/scheduler.sh
 * en el mismo commit: sin eso no correría nunca (trampa nº 1 de CLAUDE.md).
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }
  const result = await sweepCartera(prisma);
  return NextResponse.json(result);
}
