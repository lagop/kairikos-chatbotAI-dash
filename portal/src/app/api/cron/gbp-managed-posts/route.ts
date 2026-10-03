import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { sweepGbpManagedPosts } from '@/lib/gbp-managed';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Plan de precios del 01/10/2026 — GET /api/cron/gbp-managed-posts
 *
 * La Ficha de Google gestionada: ata contratos sin ficha, escribe el
 * borrador semanal de cada ficha gestionada y publica los que pasaron su
 * plazo sin que el cliente los descartara (lib/gbp-managed.ts).
 *
 * Idempotente: el scheduler la llama cada pocos minutos y la lógica de «¿toca
 * ya?» vive en sweepGbpManagedPosts, no en la cadencia. Añadida a
 * scripts/scheduler.sh en el mismo commit: sin eso no correría nunca.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }
  const result = await sweepGbpManagedPosts(prisma);
  return NextResponse.json(result);
}
