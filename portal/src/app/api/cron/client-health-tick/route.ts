import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';
import { sweepClientHealth, type ClientHealthResult } from '@/lib/client-health';
import { sweepValueReports, type ValueReportSweepResult } from '@/lib/client-value-report';
import { sweepOnboardingDrip, type DripSweepResult } from '@/lib/client-onboarding-drip';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// =============================================================================
// A8, A6 y A4 — el tick de la salud de los clientes.
//
// Un solo endpoint con tres trabajos, igual que recall-tick: cada uno decide
// por su cuenta si le toca (patrón isDigestDue), así que llamarlo cada cinco
// minutos no manda nada dos veces.
//
// Va en scripts/scheduler.sh — sin esa línea no correría nunca, que es la
// trampa 1 de CLAUDE.md y la razón de que esto se escriba aquí.
//
// Los tres trabajos están aislados: si el de riesgo de baja falla, el informe
// de valor se manda igual. Un tick que se cae entero por un job es un tick
// que deja de hacer las otras dos cosas sin que nadie lo note.
// =============================================================================

export async function GET(req: NextRequest) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const now = new Date();

  let health: ({ ok: true } & ClientHealthResult) | { ok: false; error: string };
  try {
    const result = await sweepClientHealth(prisma, now);
    health = { ok: true, ...result };
  } catch (err) {
    logError('client_health_tick.health_failed', err, {}, 'warn');
    health = { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }

  let valueReports: ({ ok: true } & ValueReportSweepResult) | { ok: false; error: string };
  try {
    const result = await sweepValueReports(prisma, now);
    valueReports = { ok: true, ...result };
  } catch (err) {
    logError('client_health_tick.value_reports_failed', err, {}, 'warn');
    valueReports = { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }

  let drip: ({ ok: true } & DripSweepResult) | { ok: false; error: string };
  try {
    const result = await sweepOnboardingDrip(prisma, now);
    drip = { ok: true, ...result };
  } catch (err) {
    logError('client_health_tick.drip_failed', err, {}, 'warn');
    drip = { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }

  return NextResponse.json({ ok: true, health, valueReports, drip });
}
