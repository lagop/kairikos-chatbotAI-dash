import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { requireTotpStepUp } from '@/lib/operator-totp-stepup';
import { updateDraftPricing } from '@/lib/stripe-catalog';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({
  priceCents: z.number().int().nonnegative(),
  setupFeeCents: z.number().int().nonnegative(),
  expectedPriceCents: z.number().int().nonnegative(),
  expectedSetupFeeCents: z.number().int().nonnegative(),
});

/**
 * POST /api/admin/portal/settings/products/[productId]/draft-price
 *
 * Sets the price a tier will be created WITH on Stripe, before Bootstrap
 * has ever run — the gap that left an operator with no way to fix a
 * seeded price short of editing prisma/seed.ts and redeploying.
 *
 * Deliberately does NOT call isStripeConfigured() or touch Stripe at
 * all: this only ever writes the Product row, so it works even before a
 * Stripe key has been saved. Requires the same TOTP step-up as reprice —
 * it is still setting what a client will be charged, even though no
 * Stripe object exists yet to reflect that back.
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

  let result;
  try {
    result = await updateDraftPricing(
      {
        productId: params.productId,
        newPriceCents: body.data.priceCents,
        newSetupFeeCents: body.data.setupFeeCents,
        expectedPriceCents: body.data.expectedPriceCents,
        expectedSetupFeeCents: body.data.expectedSetupFeeCents,
      },
      actor,
    );
  } catch (err) {
    logError('stripe_catalog.draft_price_failed', err, { productId: params.productId });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  if (!result.ok) {
    switch (result.error.kind) {
      case 'already_bootstrapped':
        // The client had a stale bootstrapped=false — someone else ran
        // Bootstrap in between. Reprice is the only valid path from here.
        return NextResponse.json({ error: 'already_bootstrapped' }, { status: 409 });
      case 'concurrent_modification':
        return NextResponse.json({ error: 'concurrent_modification' }, { status: 409 });
      default:
        return NextResponse.json({ error: 'internal_error' }, { status: 500 });
    }
  }
  return NextResponse.json({ ok: true, product: result.product });
}
