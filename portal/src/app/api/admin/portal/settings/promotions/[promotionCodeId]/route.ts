import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { isStripeConfigured } from '@/lib/stripe';
import { deactivateSetupFeeWaiverCode } from '@/lib/stripe-promotions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// DELETE /api/admin/portal/settings/promotions/[promotionCodeId] — desactiva
// un código creado desde el portal. Stripe no deja borrar un código, solo
// desactivarlo; los clientes que ya lo usaron no se ven afectados.
//
// Sin TOTP a propósito: desactivar solo puede hacer que se cobre MÁS, nunca
// menos, y tiene que poder hacerse deprisa si un código se filtra. Sí exige
// una sesión de operador real, para que quede quién lo hizo.
// =============================================================================

export async function DELETE(req: NextRequest, { params }: { params: { promotionCodeId: string } }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (auth.operatorId === 'legacy') {
    return NextResponse.json({ error: 'operator_session_required' }, { status: 403 });
  }
  if (!/^promo_[A-Za-z0-9]+$/.test(params.promotionCodeId)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (!(await isStripeConfigured())) {
    return NextResponse.json({ error: 'service_unavailable', detail: 'stripe_not_configured' }, { status: 503 });
  }

  const operator = await prisma.operator.findUnique({ where: { id: auth.operatorId }, select: { email: true } });
  const result = await deactivateSetupFeeWaiverCode(params.promotionCodeId, {
    operatorId: auth.operatorId,
    operatorEmail: operator?.email ?? null,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.error === 'not_found' ? 404 : 502 });
  }
  return NextResponse.json({ ok: true });
}
