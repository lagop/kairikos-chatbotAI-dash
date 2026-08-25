import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { requireTotpStepUp } from '@/lib/operator-totp-stepup';
import { resetForModeMismatch } from '@/lib/stripe-catalog';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/admin/portal/settings/products/[productId]/reset-mode
 *
 * Test and live are fully separate namespaces in Stripe — a Product/Price
 * id created under one key is meaningless, and errors, under the other.
 * There is no migrate-in-place, so this is the only way forward when the
 * panel shows a tier as "⚠️ creado en test, activo es live": it clears
 * the stored Stripe pointer, which reopens Bootstrap exactly as if the
 * tier had never been touched.
 *
 * Requires the same TOTP step-up as bootstrap/reprice — it permanently
 * unlinks a real Stripe object, even though it never calls Stripe itself.
 */
export async function POST(req: NextRequest, { params }: { params: { productId: string } }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const stepUp = await requireTotpStepUp(req);
  if (!stepUp.ok) return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });

  const product = await prisma.product.findUnique({ where: { id: params.productId }, select: { id: true } });
  if (!product) return NextResponse.json({ error: 'product_not_found' }, { status: 404 });

  const operator = await prisma.operator.findUnique({ where: { id: stepUp.operatorId }, select: { email: true } });
  const actor = { operatorId: stepUp.operatorId, operatorEmail: operator?.email ?? null };

  let result;
  try {
    result = await resetForModeMismatch(params.productId, actor);
  } catch (err) {
    logError('stripe_catalog.reset_mode_failed', err, { productId: params.productId });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  if (!result.ok) {
    switch (result.error.kind) {
      case 'not_bootstrapped_yet':
        return NextResponse.json({ error: 'not_bootstrapped_yet' }, { status: 409 });
      case 'no_mode_mismatch':
        return NextResponse.json({ error: 'no_mode_mismatch' }, { status: 409 });
      case 'has_active_subscriptions':
        return NextResponse.json(
          { error: 'has_active_subscriptions', count: result.error.count },
          { status: 409 },
        );
      default:
        return NextResponse.json({ error: 'internal_error' }, { status: 500 });
    }
  }
  return NextResponse.json({ ok: true, product: result.product });
}
