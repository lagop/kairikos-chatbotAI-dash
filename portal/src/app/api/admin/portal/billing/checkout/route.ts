import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { isDatabaseConfigured, prisma } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { getStripe, isStripeConfigured } from '@/lib/stripe';
import { ensureCustomerForTenant } from '@/lib/stripe-billing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({
  clientProductId: z.string().uuid(),
  // Optional: if absent, return the URL the operator should send the
  // client to (Checkout Session). When present, redirect the operator
  // straight into Stripe's hosted checkout.
  returnUrl: z.string().url().optional(),
});

/**
 * KAIA-4262 — Create a Stripe Checkout Session for a ClientProduct.
 *
 * Route shape:
 *   POST /api/admin/portal/billing/checkout
 *   body: { clientProductId: UUID, returnUrl?: URL }
 *
 * Behaviour:
 *   1. Resolve the ClientProduct and its tenant.
 *   2. Ensure the Stripe Customer exists for the tenant
 *      (idempotent via Tenant.stripe_customer_id).
 *   3. Look up the Product.stripe_price_id — if it is NULL the
 *      operator must provision it on Stripe first.
 *   4. Create a Subscription directly (mode='subscription') rather
 *      than a Checkout Session — for an operator-initiated onboarding
 *      we do NOT want the operator to re-enter payment details; the
 *      owner collects payment details out of band and the subscription
 *      starts as 'incomplete' until the webhook flips it to 'active'.
 *      For Fase 4 self-serve, the same flow will run with a Checkout
 *      Session instead of a direct subscription create.
 *
 * Responses:
 *   201 { subscriptionId, stripeSubscriptionId, stripeCustomerId, status }
 *   400 { error: 'invalid_body', details }
 *   401 { error: 'unauthorized' }
 *   404 { error: 'client_product_not_found' | 'product_price_id_missing' }
 *   503 { error: 'service_unavailable' }
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable', detail: 'database_not_configured' }, { status: 503 });
  }
  if (!isStripeConfigured()) {
    return NextResponse.json({ error: 'service_unavailable', detail: 'stripe_not_configured' }, { status: 503 });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }
  const { clientProductId } = body.data;

  const cp = await prisma.clientProduct.findUnique({
    where: { id: clientProductId },
    include: {
      product: true,
      client: { select: { id: true, tenantId: true, email: true, name: true } },
    },
  });
  if (!cp) return NextResponse.json({ error: 'client_product_not_found' }, { status: 404 });
  if (!cp.product.stripePriceId) {
    return NextResponse.json({ error: 'product_price_id_missing', productId: cp.product.id, tier: cp.product.tier }, { status: 404 });
  }
  if (!cp.client.tenantId) {
    return NextResponse.json({ error: 'client_product_not_found', detail: 'client_has_no_tenant' }, { status: 404 });
  }

  const customerId = await ensureCustomerForTenant(cp.client.tenantId);
  if (!customerId) {
    return NextResponse.json({ error: 'service_unavailable', detail: 'stripe_customer_create_failed' }, { status: 503 });
  }

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: cp.product.stripePriceId }],
    // Payment is collected out-of-band for the operator flow; the
    // subscription starts incomplete and the webhook flips it to
    // active when Stripe confirms payment.
    payment_behavior: 'default_incomplete',
    payment_settings: { save_default_payment_method: 'on_subscription' },
    expand: ['latest_invoice.payment_intent'],
    metadata: {
      kairikos_tenant_id: cp.client.tenantId,
      kairikos_client_id: cp.client.id,
      kairikos_client_product_id: cp.id,
      kairikos_product_tier: cp.product.tier,
    },
  });

  // Write the Subscription row synchronously so the operator UI gets
  // an immediate id. The webhook will upsert the same row when the
  // subscription state changes; the UNIQUE stripe_id constraint
  // guarantees the webhook is a no-op on this row's existence.
  const created = await prisma.subscription.upsert({
    where: { stripeId: subscription.id },
    create: {
      tenantId: cp.client.tenantId,
      clientId: cp.client.id,
      clientProductId: cp.id,
      stripeId: subscription.id,
      stripeCustomerId: customerId,
      stripePriceId: cp.product.stripePriceId,
      status: subscription.status,
      currentPeriodStart: new Date(((subscription as unknown as { current_period_start?: number }).current_period_start ?? 0) * 1000),
      currentPeriodEnd: new Date(((subscription as unknown as { current_period_end?: number }).current_period_end ?? 0) * 1000),
      cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
      amountCents: cp.product.priceCents,
      currency: cp.product.currency,
      metadata: subscription.metadata as Prisma.InputJsonValue,
    },
    update: {},
  });

  return NextResponse.json(
    {
      subscriptionId: created.id,
      stripeSubscriptionId: subscription.id,
      stripeCustomerId: customerId,
      status: created.status,
    },
    { status: 201 },
  );
}
