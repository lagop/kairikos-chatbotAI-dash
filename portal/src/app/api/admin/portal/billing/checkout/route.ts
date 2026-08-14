import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { isDatabaseConfigured, prisma } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { getStripe, isStripeConfigured } from '@/lib/stripe';
import { ensureCustomerForTenant, createOneTimeInvoice, syncInvoiceFromStripe, toDate } from '@/lib/stripe-billing';

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
 * KAIA-4262 / WP-19 — Bill a ClientProduct: subscription for a recurring
 * product, one-off Invoice for a one-time-purchase product.
 *
 * Route shape:
 *   POST /api/admin/portal/billing/checkout
 *   body: { clientProductId: UUID, returnUrl?: URL }
 *
 * Behaviour:
 *   1. Resolve the ClientProduct and its tenant.
 *   2. Ensure the Stripe Customer exists for the tenant
 *      (idempotent via Tenant.stripe_customer_id).
 *   3. Branch on whether the product has a recurring price:
 *        - Product.stripeRecurringPriceId set → create a Subscription
 *          directly (mode='subscription') rather than a Checkout
 *          Session — for an operator-initiated onboarding we do NOT
 *          want the operator to re-enter payment details; the owner
 *          collects payment details out of band and the subscription
 *          starts as 'incomplete' until the webhook flips it to
 *          'active'.
 *        - No recurring price (a one-time-purchase product, e.g. the
 *          web platform) → the product MUST have a setup fee with its
 *          Stripe price provisioned; create + finalize a one-off
 *          Invoice instead (send_invoice, no Subscription at all — see
 *          src/lib/stripe-billing.ts's createOneTimeInvoice). Its
 *          status starts 'open' and the invoice.paid webhook flips it
 *          to 'paid' once the client pays — same "collected out of
 *          band" shape as the subscription path, just without a
 *          recurring price backing it.
 *      For Fase 4 self-serve (WP-30), the same branching will run
 *      behind a Checkout Session instead of a direct create.
 *
 * Responses:
 *   201 { subscriptionId, stripeSubscriptionId, stripeCustomerId, status }
 *     (recurring product)
 *   201 { invoiceId, stripeInvoiceId, stripeCustomerId, status, hostInvoiceUrl }
 *     (one-time-purchase product)
 *   400 { error: 'invalid_body', details }
 *   401 { error: 'unauthorized' }
 *   404 { error: 'client_product_not_found' | 'product_price_id_missing' | 'product_setup_price_id_missing' }
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
  // WP-19 — a product with no recurring price at all (e.g. the web
  // platform: pago único, sin cuota) never had a way to be billed
  // through this route; it always 404'd here. That's the "modelo actual
  // asume una suscripción por cliente-tier" gap this WP closes.
  const isOneTimeOnly = !cp.product.stripeRecurringPriceId;
  if (isOneTimeOnly && cp.product.setupFeeCents === 0) {
    return NextResponse.json({ error: 'product_price_id_missing', productId: cp.product.id, tier: cp.product.tier }, { status: 404 });
  }
  // WP-12 — a product can now carry a one-time setup fee alongside its
  // recurring price (e.g. chatbot: subscription + onboarding fee). If
  // there's a fee to charge, its Stripe price must be provisioned too —
  // otherwise the client is silently undercharged for a real cost. For
  // a one-time-only product the setup fee IS the whole charge, so the
  // same check applies unconditionally there.
  if (cp.product.setupFeeCents > 0 && !cp.product.stripeSetupPriceId) {
    return NextResponse.json(
      { error: 'product_setup_price_id_missing', productId: cp.product.id, tier: cp.product.tier },
      { status: 404 },
    );
  }
  if (!cp.client.tenantId) {
    return NextResponse.json({ error: 'client_product_not_found', detail: 'client_has_no_tenant' }, { status: 404 });
  }

  const customerId = await ensureCustomerForTenant(cp.client.tenantId);
  if (!customerId) {
    return NextResponse.json({ error: 'service_unavailable', detail: 'stripe_customer_create_failed' }, { status: 503 });
  }

  const metadata = {
    kairikos_tenant_id: cp.client.tenantId,
    kairikos_client_id: cp.client.id,
    kairikos_client_product_id: cp.id,
    kairikos_product_code: cp.product.code,
    kairikos_product_tier: cp.product.tier,
  };

  if (isOneTimeOnly) {
    // setupFeeCents > 0 and stripeSetupPriceId provisioned — checked above.
    const invoice = await createOneTimeInvoice({
      clientProductId: cp.id,
      stripeCustomerId: customerId,
      stripeSetupPriceId: cp.product.stripeSetupPriceId!,
      metadata,
    });
    // Persist synchronously so the operator UI gets an immediate id,
    // same reasoning as the subscription path below — syncInvoiceFromStripe
    // upserts on the UNIQUE stripe_id, so the webhook's later delivery
    // of invoice.created/finalized is a no-op on this row's existence.
    await syncInvoiceFromStripe(invoice);
    const created = await prisma.invoice.findUniqueOrThrow({ where: { stripeId: invoice.id ?? '' } });

    return NextResponse.json(
      {
        invoiceId: created.id,
        stripeInvoiceId: invoice.id,
        stripeCustomerId: customerId,
        status: created.status,
        hostInvoiceUrl: created.hostInvoiceUrl,
      },
      { status: 201 },
    );
  }

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: cp.product.stripeRecurringPriceId! }],
    // WP-12 — a one-time setup fee bills as an invoice item attached to
    // the subscription's first invoice, alongside the recurring price.
    ...(cp.product.stripeSetupPriceId
      ? { add_invoice_items: [{ price: cp.product.stripeSetupPriceId }] }
      : {}),
    // Payment is collected out-of-band for the operator flow; the
    // subscription starts incomplete and the webhook flips it to
    // active when Stripe confirms payment.
    payment_behavior: 'default_incomplete',
    payment_settings: { save_default_payment_method: 'on_subscription' },
    expand: ['latest_invoice.payment_intent'],
    metadata,
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
      stripePriceId: cp.product.stripeRecurringPriceId,
      status: subscription.status,
      // WP-19 — a fresh 'incomplete' subscription hasn't billed a
      // period yet, so Stripe leaves current_period_start/end
      // unpopulated. `?? 0` used to turn that into `new Date(0)`
      // (1970-01-01) written as a real billing date; toDate() (already
      // used everywhere else in stripe-billing.ts) returns null instead.
      currentPeriodStart: toDate((subscription as unknown as { current_period_start?: number }).current_period_start),
      currentPeriodEnd: toDate((subscription as unknown as { current_period_end?: number }).current_period_end),
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
