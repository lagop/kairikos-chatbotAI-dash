import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { sweepVillas } from '@/lib/villas/sweep';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Reserva propia para villas — GET /api/cron/villas-tick
 *
 * Lee los iCal de Airbnb/Booking que tocan, caduca las solicitudes sin
 * respuesta y repasa los depósitos (lib/villas/sweep.ts).
 *
 * Idempotente: el scheduler la llama cada 5 minutos y la lógica de «¿toca
 * ya?» vive en sweepVillas, no en la cadencia. Añadida a scripts/scheduler.sh
 * en el mismo commit: sin eso no correría nunca.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }
  const result = await sweepVillas(prisma);
  return NextResponse.json(result);
}
