import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { sweepInboundFollowUps } from '@/lib/inbound-follow-up';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * 25/10/2026 — GET /api/cron/inbound-follow-up
 *
 * Seguimiento por correo (días 0, 3 y 7) a quien pidió su borrador de web o
 * usó la calculadora en kairikos.com y marcó la casilla de comunicaciones
 * comerciales (lib/inbound-follow-up.ts). El scheduler la llama cada 5
 * minutos; qué toca y a quién lo decide el barrido, y cada toque se reserva
 * antes de mandarse, así que llamarla de más no manda nada dos veces.
 * Añadida a scripts/scheduler.sh en el mismo commit.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }
  const result = await sweepInboundFollowUps(prisma);
  return NextResponse.json(result);
}
