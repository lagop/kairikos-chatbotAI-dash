import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { sweepDueConversationsForClassification } from '@/lib/lead-classification-sweep';
import { sweepStaleLeadAlerts } from '@/lib/lead-stale-alerts';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * "Sistema IA de captación" — GET /api/cron/classify-leads
 *
 * Invoked by scripts/scheduler.sh on the VPS (vercel.json's schedule is
 * inert on Docker Compose — see that file's own header). Same auth
 * convention as every other cron route: CRON_SECRET as
 * `Authorization: Bearer <CRON_SECRET>`.
 *
 * sweepDueConversationsForClassification() re-checks due-ness and the
 * per-client monthly cap on every call, so a coarser real invocation
 * cadence never causes duplicate classification or runaway cost — a
 * missed tick just means a conversation's lead lands later.
 */
function isAuthorizedCronRequest(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }
  const result = await sweepDueConversationsForClassification(prisma);

  // Fase 2.4 — el aviso de leads fríos vive en este mismo tick: es el mismo
  // producto y la misma cadencia. Aislado para que un fallo de correo no
  // convierta una clasificación correcta en un error del cron.
  let staleAlerts: Awaited<ReturnType<typeof sweepStaleLeadAlerts>> | { error: string };
  try {
    staleAlerts = await sweepStaleLeadAlerts(prisma);
  } catch (err) {
    logError('classify_leads_cron.stale_alerts_failed', err, {}, 'warn');
    staleAlerts = { error: err instanceof Error ? err.message : 'unknown error' };
  }

  return NextResponse.json({ ...result, staleAlerts });
}
