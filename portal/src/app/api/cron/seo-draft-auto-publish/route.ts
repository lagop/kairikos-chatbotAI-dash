import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { sweepAutoPublishableSeoDrafts } from '@/lib/seo-draft-auto-publish';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * SEO con IA, Fase 6 — GET /api/cron/seo-draft-auto-publish
 *
 * La segunda ventana de "publicar salvo veto": publica todo borrador
 * que lleve más de SEO_DRAFT_CLIENT_REVIEW_WINDOW_DAYS en
 * 'pending_client_review' sin que el cliente lo haya aprobado o pedido
 * cambios desde /portal/seo.
 *
 * Misma convención de auth que cada /api/cron/* de este stack:
 * `Authorization: Bearer <CRON_SECRET>`, cierre en falso si no está
 * configurado. Y la misma trampa de siempre: sin entrada en
 * scripts/scheduler.sh este endpoint no se ejecuta nunca en la VPS —
 * ya está añadida en el mismo commit.
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
  const result = await sweepAutoPublishableSeoDrafts(prisma);
  return NextResponse.json(result);
}
