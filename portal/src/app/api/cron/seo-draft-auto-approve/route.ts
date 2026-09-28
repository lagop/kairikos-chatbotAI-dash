import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { sweepAutoApprovableSeoDrafts } from '@/lib/seo-draft-auto-approve';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * SEO con IA, Fase 5 — GET /api/cron/seo-draft-auto-approve
 *
 * "Aprobación con ventana: publicar salvo veto pasados unos días... la
 * revisión se conserva; deja de ser el camino." Aprueba (y publica) todo
 * borrador que lleve más de SEO_DRAFT_AUTO_APPROVE_VETO_WINDOW_DAYS en
 * 'drafted' sin que un operador lo haya aprobado o rechazado a mano.
 *
 * Misma convención de auth que cada /api/cron/* de este stack:
 * `Authorization: Bearer <CRON_SECRET>`, cierre en falso si no está
 * configurado. Y la misma trampa de siempre: sin entrada en
 * scripts/scheduler.sh este endpoint no se ejecuta nunca en la VPS —
 * ya está añadida en el mismo commit.
 */

export async function GET(req: NextRequest) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }
  const result = await sweepAutoApprovableSeoDrafts(prisma);
  return NextResponse.json(result);
}
