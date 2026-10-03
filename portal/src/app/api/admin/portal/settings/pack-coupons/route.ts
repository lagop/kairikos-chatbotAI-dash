import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { requireTotpStepUp } from '@/lib/operator-totp-stepup';
import { isStripeConfigured } from '@/lib/stripe';
import { createPackCoupons } from '@/lib/pack-discounts';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/admin/portal/settings/pack-coupons
 *
 * Plan de precios del 01/10/2026 — crea en Stripe los cupones de los packs de
 * productos (Oficio, Presencia) que falten. Mismo segundo factor que el resto
 * del catálogo: es dinero que deja de cobrarse.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const stepUp = await requireTotpStepUp(req);
  if (!stepUp.ok) return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });
  if (!(await isStripeConfigured())) {
    return NextResponse.json({ error: 'service_unavailable', detail: 'stripe_not_configured' }, { status: 503 });
  }

  const operator = await prisma.operator.findUnique({ where: { id: stepUp.operatorId }, select: { email: true } });
  let result;
  try {
    result = await createPackCoupons(prisma, { operatorId: stepUp.operatorId, operatorEmail: operator?.email ?? null });
  } catch (err) {
    logError('pack_coupons.create_failed', err, {});
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.error === 'stripe_error' ? 502 : 409 });
  }
  return NextResponse.json(result);
}
