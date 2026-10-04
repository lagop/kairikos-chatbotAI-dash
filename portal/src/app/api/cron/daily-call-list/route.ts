import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { sendDailyCallList } from '@/lib/daily-call-list';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * 04/10/2026 — GET /api/cron/daily-call-list
 *
 * La lista diaria de prospectos a los que llamar, al operador, de lunes a
 * viernes a partir de las 8:30 en Madrid (lib/daily-call-list.ts). Una vez
 * al día: el scheduler la llama cada 5 minutos y la lógica de «¿toca ya?»
 * vive en sendDailyCallList. Añadida a scripts/scheduler.sh en el mismo commit.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }
  const result = await sendDailyCallList(prisma);
  return NextResponse.json(result);
}
