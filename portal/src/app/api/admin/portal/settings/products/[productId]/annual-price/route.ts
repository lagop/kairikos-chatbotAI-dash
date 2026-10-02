import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { requireTotpStepUp } from '@/lib/operator-totp-stepup';
import { isStripeConfigured } from '@/lib/stripe';
import { createAnnualPriceForTier } from '@/lib/stripe-catalog';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/admin/portal/settings/products/[productId]/annual-price
 *
 * Plan de precios del 01/10/2026 — crea el precio anual (12 meses por el
 * precio de 10, sin alta) de un escalón que ya está en Stripe y todavía no lo
 * tiene. Mismo segundo factor que el resto de cambios del catálogo: es un
 * precio nuevo que se puede cobrar.
 */
export async function POST(req: NextRequest, props: { params: Promise<{ productId: string }> }) {
  const params = await props.params;
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const stepUp = await requireTotpStepUp(req);
  if (!stepUp.ok) return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });

  if (!(await isStripeConfigured())) {
    return NextResponse.json({ error: 'service_unavailable', detail: 'stripe_not_configured' }, { status: 503 });
  }

  const product = await prisma.product.findUnique({ where: { id: params.productId }, select: { id: true } });
  if (!product) return NextResponse.json({ error: 'product_not_found' }, { status: 404 });

  const operator = await prisma.operator.findUnique({ where: { id: stepUp.operatorId }, select: { email: true } });
  const actor = { operatorId: stepUp.operatorId, operatorEmail: operator?.email ?? null };

  // Mismo catch que el Bootstrap: descifrar la clave de Stripe guardada puede
  // lanzar en vez de devolver un resultado.
  let result;
  try {
    result = await createAnnualPriceForTier(params.productId, actor);
  } catch (err) {
    logError('stripe_catalog.annual_price_failed', err, { productId: params.productId });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
  if (!result.ok) {
    switch (result.error.kind) {
      case 'not_bootstrapped_yet':
      case 'annual_already_exists':
        return NextResponse.json({ error: result.error.kind }, { status: 409 });
      case 'annual_not_applicable':
        return NextResponse.json({ error: 'annual_not_applicable' }, { status: 400 });
      case 'partial_failure':
        return NextResponse.json({ error: 'partial_failure', ...result.error }, { status: 502 });
      default:
        return NextResponse.json({ error: 'stripe_error' }, { status: 502 });
    }
  }
  return NextResponse.json({ ok: true, product: result.product });
}
