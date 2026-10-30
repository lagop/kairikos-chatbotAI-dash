import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { sweepPublicDrafts } from '@/lib/public-draft-delivery';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * 30/10/2026 — GET /api/cron/public-drafts
 *
 * Los borradores de kairikos.com se entregan en menos de 24 horas
 * (lib/public-draft-delivery.ts). El barrido escribe los que la ruta pública
 * no llegó a escribir y envía los que cumplen el plazo sin que el operador
 * los haya mandado antes. Va en scripts/scheduler.sh justo antes de
 * inbound-follow-up, en el mismo commit; las dos cosas se reservan antes de
 * hacerse, así que llamarla de más no escribe ni manda nada dos veces.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }
  const result = await sweepPublicDrafts(prisma);
  return NextResponse.json(result);
}
