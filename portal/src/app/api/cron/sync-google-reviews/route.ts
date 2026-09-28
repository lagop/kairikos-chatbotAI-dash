import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { syncAllDueConnections } from '@/lib/google-review-sync';
import { sweepReviewRequestsFromLeads } from '@/lib/review-requests-from-leads';
import { logError } from '@/lib/observability';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * WP-22a — GET /api/cron/sync-google-reviews
 *
 * El tick del producto 'reviews'. Lo invoca scripts/scheduler.sh en la
 * VPS: vercel.json declara un horario pero es inerte, este stack no está
 * en Vercel. Auth como todas las rutas de cron: CRON_SECRET en
 * `Authorization: Bearer <CRON_SECRET>`.
 *
 * `syncAllDueConnections` recomprueba `isSyncDue` por conexión
 * (GOOGLE_REVIEWS_SYNC_MIN_INTERVAL_MINUTES), así que una cadencia real
 * más gruesa nunca provoca sincronizaciones duplicadas — solo que las
 * reseñas tarden más en refrescarse.
 *
 * Fase 5 — el barrido de invitaciones a reseñar a partir de los leads
 * convertidos vive en ESTE tick y no en uno propio, por dos motivos: es
 * el mismo producto y la misma cadencia, y una entrada nueva en
 * scheduler.sh es justo lo que se olvida (un cron que no está en esa
 * lista no se ejecuta jamás, sin dar error). Aislado en su try/catch: un
 * fallo invitando no puede dejar sin sincronizar las reseñas de todos.
 */

export async function GET(req: NextRequest) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }
  const result = await syncAllDueConnections();

  let reviewRequests: Awaited<ReturnType<typeof sweepReviewRequestsFromLeads>> | { error: string };
  try {
    reviewRequests = await sweepReviewRequestsFromLeads(prisma);
  } catch (err) {
    logError('sync_google_reviews_cron.lead_requests_failed', err, {}, 'warn');
    reviewRequests = { error: err instanceof Error ? err.message : 'unknown error' };
  }

  return NextResponse.json({ ...result, reviewRequests });
}
