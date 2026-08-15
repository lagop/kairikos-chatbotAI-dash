import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { requireTotpStepUp } from '@/lib/operator-totp-stepup';
import { reconcileStripeProductForTier } from '@/lib/stripe-catalog';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({
  stripeProductId: z.string().min(1),
  stripeRecurringPriceId: z.string().min(1).nullish(),
  stripeSetupPriceId: z.string().min(1).nullish(),
});

/**
 * POST /api/admin/portal/settings/products/[productId]/reconcile
 *
 * Recovery path after a bootstrap/reprice partial_failure: the Stripe
 * objects already exist (returned in that error response), so this
 * ONLY persists them to Prisma — it never calls Stripe again. Still
 * requires a fresh TOTP step-up since it mutates the catalog.
 */
export async function POST(req: NextRequest, { params }: { params: { productId: string } }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const stepUp = await requireTotpStepUp(req);
  if (!stepUp.ok) return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  const product = await prisma.product.findUnique({ where: { id: params.productId }, select: { id: true } });
  if (!product) return NextResponse.json({ error: 'product_not_found' }, { status: 404 });

  const operator = await prisma.operator.findUnique({ where: { id: stepUp.operatorId }, select: { email: true } });
  const actor = { operatorId: stepUp.operatorId, operatorEmail: operator?.email ?? null };

  const result = await reconcileStripeProductForTier(
    params.productId,
    {
      stripeProductId: body.data.stripeProductId,
      stripeRecurringPriceId: body.data.stripeRecurringPriceId ?? null,
      stripeSetupPriceId: body.data.stripeSetupPriceId ?? null,
    },
    actor,
  );
  // reconcileStripeProductForTier only ever writes to Prisma (no Stripe
  // calls), so it never returns the `ok: false` branch of the shared
  // CatalogMutationResult union — but the type is shared, so narrow here.
  if (!result.ok) {
    return NextResponse.json({ error: 'reconcile_failed' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, product: result.product });
}
