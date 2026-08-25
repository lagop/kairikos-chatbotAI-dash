import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { requireTotpStepUp } from '@/lib/operator-totp-stepup';
import { isStripeConfigured } from '@/lib/stripe';
import { bootstrapStripeProductForTier } from '@/lib/stripe-catalog';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/admin/portal/settings/products/[productId]/bootstrap
 *
 * First-time creation of the Stripe Product + Price(s) for a tier that
 * still has a placeholder id. Requires a fresh TOTP step-up.
 */
export async function POST(req: NextRequest, { params }: { params: { productId: string } }) {
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

  // See the credentials route's POST for why this needs its own
  // catch: resolveActiveStripeSecret() (inside
  // bootstrapStripeProductForTier) decrypts the stored key, and a
  // misconfigured STRIPE_CREDENTIAL_ENCRYPTION_KEY throws synchronously
  // rather than returning a result the switch below could handle.
  let result;
  try {
    result = await bootstrapStripeProductForTier(params.productId, actor);
  } catch (err) {
    logError('stripe_catalog.bootstrap_failed', err, { productId: params.productId });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
  if (!result.ok) {
    switch (result.error.kind) {
      case 'already_bootstrapped':
        return NextResponse.json({ error: 'already_bootstrapped' }, { status: 409 });
      case 'partial_failure':
        return NextResponse.json({ error: 'partial_failure', ...result.error }, { status: 502 });
      default:
        return NextResponse.json({ error: 'stripe_error' }, { status: 502 });
    }
  }
  return NextResponse.json({ ok: true, product: result.product });
}
