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
 * Un solo barrido (lib/cartera/publish.ts, sweepCartera): borra los contactos
 * de más de 24 meses (una vez al día por sitio), procesa las bajas (aviso a la
 * agencia y, pasada la gracia, la purga: lib/cartera/exit.ts), pasa a
 * «desconocida» lo que lleva 45 minutos sin noticias y publica lo pendiente.
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
