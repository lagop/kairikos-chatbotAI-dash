import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { sweepAutoApprovableWizardSteps } from '@/lib/wizard-auto-approve';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Fase 5 — GET /api/cron/wizard-auto-approve
 *
 * "Aprobar salvo veto": aprueba solo los pasos del wizard marcados de
 * bajo riesgo (`autoApprovableStepKeys` en src/lib/catalogs) que llevan
 * más de `AUTO_APPROVE_VETO_WINDOW_HOURS` en `submitted` sin que ningún
 * operador haya actuado. Ver la cabecera de
 * src/lib/wizard-auto-approve.ts para por qué es un cron del portal y
 * no parte del flujo de n8n que ya vigila los pasos atrasados.
 *
 * Misma convención que cada /api/cron/* de este stack:
 * `Authorization: Bearer <CRON_SECRET>`, cierre en falso si no está
 * configurado. Y la misma trampa de siempre — sin entrada en
 * scripts/scheduler.sh, este endpoint no se ejecuta NUNCA en la VPS y no
 * avisa de ello; ya está añadido en el mismo commit.
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
  const result = await sweepAutoApprovableWizardSteps(prisma);
  return NextResponse.json(result);
}
