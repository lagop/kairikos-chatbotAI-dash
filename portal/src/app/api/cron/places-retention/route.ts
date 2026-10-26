import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { purgeExpiredPlacesContent } from '@/lib/places-retention';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * 26/10/2026 — GET /api/cron/places-retention
 *
 * Borra el contenido de Google Places que lleva más de 30 días guardado
 * (lib/places-retention.ts): coordenadas de todos los leads, el resto de los
 * prospectos que nadie ha tocado, y las fotos de la zona. El scheduler la
 * llama cada 5 minutos; lo ya purgado no vuelve a entrar, así que llamarla
 * de más no hace nada. Añadida a scripts/scheduler.sh en el mismo commit.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }
  const result = await purgeExpiredPlacesContent(prisma);
  return NextResponse.json(result);
}
