import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { requireTotpStepUp } from '@/lib/operator-totp-stepup';
import { isStripeConfigured } from '@/lib/stripe';
import { repriceStripeTier } from '@/lib/stripe-catalog';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({
  priceCents: z.number().int().nonnegative(),
  // null/omitted = leave the setup fee untouched.
  setupFeeCents: z.number().int().nonnegative().nullish(),
  expectedPriceCents: z.number().int().nonnegative(),
  expectedSetupFeeCents: z.number().int().nonnegative(),
});

/**
 * POST /api/admin/portal/settings/products/[productId]/reprice
 *
 * Changes a bootstrapped tier's price. Requires a fresh TOTP step-up —
 * this creates real Stripe billing objects. Existing subscribers keep
 * their current price (see stripe-catalog.ts).
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

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  const product = await prisma.product.findUnique({ where: { id: params.productId }, select: { id: true } });
  if (!product) return NextResponse.json({ error: 'product_not_found' }, { status: 404 });

  const operator = await prisma.operator.findUnique({ where: { id: stepUp.operatorId }, select: { email: true } });
  const actor = { operatorId: stepUp.operatorId, operatorEmail: operator?.email ?? null };

  const result = await repriceStripeTier(
    {
      productId: params.productId,
      newPriceCents: body.data.priceCents,
      newSetupFeeCents: body.data.setupFeeCents ?? null,
      expectedPriceCents: body.data.expectedPriceCents,
      expectedSetupFeeCents: body.data.expectedSetupFeeCents,
    },
    actor,
  );
  if (!result.ok) {
    switch (result.error.kind) {
      case 'not_bootstrapped_yet':
        return NextResponse.json({ error: 'not_bootstrapped_yet' }, { status: 409 });
      case 'concurrent_modification':
        return NextResponse.json({ error: 'concurrent_modification' }, { status: 409 });
      case 'partial_failure':
        return NextResponse.json({ error: 'partial_failure', ...result.error }, { status: 502 });
      default:
        return NextResponse.json({ error: 'stripe_error' }, { status: 502 });
    }
  }
  return NextResponse.json({ ok: true, product: result.product });
}
