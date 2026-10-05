import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { requestReviewForCall, type CallReviewOutcome } from '@/lib/recall-reviews';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/portal/recall/calls/[callId]/review-request
 *
 * 05/10/2026 — el botón «Pedir reseña» de una llamada en /portal/llamadas
 * (en todos los escalones; en Esencial es la única forma, porque no lleva el
 * resumen del día). El id de la URL no autoriza nada: requestReviewForCall
 * busca la llamada entre las del cliente de la sesión.
 */
const STATUS: Record<CallReviewOutcome, number> = {
  sent: 200,
  not_found: 404,
  no_number: 400,
  blocked: 409,
  already_requested: 409,
  no_google: 409,
  failed: 502,
};

export async function POST(_req: NextRequest, props: { params: Promise<{ callId: string }> }) {
  const params = await props.params;
  const session = await getSession();
  if (!session.hasClientAccess) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  const resolved = await resolveClientFromSession();
  if (!resolved || resolved.source !== 'database') return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const outcome = await requestReviewForCall(prisma, { clientId: resolved.clientId, callEventId: params.callId });
  if (outcome === 'sent') return NextResponse.json({ ok: true });
  return NextResponse.json({ error: outcome }, { status: STATUS[outcome] });
}
