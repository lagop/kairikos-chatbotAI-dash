import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { isDatabaseConfigured, prisma } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { getSession } from '@/lib/session';
import { getStripe, isStripeConfigured } from '@/lib/stripe';
import { ensureCustomerForTenant } from '@/lib/stripe-billing';
import { isProductContracted } from '@/lib/client-product-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({ productId: z.string().uuid() });

/**
 * WP-30 — client-facing self-serve checkout. Distinct from the operator
 * route at `api/admin/portal/billing/checkout` (which bills an EXISTING
 * ClientProduct and never creates one): this route creates the
 * ClientProduct itself, for a product the client doesn't have yet, and is
 * the first real `stripe.checkout.sessions.create()` call in the
 * codebase — every other billing path here collects payment "out of
 * band" (operator flow) rather than through Stripe's hosted page.
 *
 *   POST /api/portal/billing/checkout
 *   body: { productId: UUID }
 *   200 { url: string }  — redirect the browser here
 *   401 { error: 'unauthorized' }
 *   404 { error: 'product_not_found' | 'product_price_id_missing' | 'product_setup_price_id_missing' }
 *   409 { error: 'already_contracted' }
 *   502 { error: 'stripe_error' }
 *   503 { error: 'service_unavailable', detail }
 *
 * Flow: the ClientProduct row is created up front, in a 'pending_payment'
 * state, with its id embedded in the Checkout Session's metadata (and, for
 * subscriptions, `subscription_data.metadata`) BEFORE the Stripe call —
 * not after. That ordering is what lets the existing webhook sync
 * functions (`syncSubscriptionFromStripe`/`syncInvoiceFromStripe`, both
 * written for the WP-19 operator flow) resolve `kairikos_client_product_id`
 * unchanged, with no special-casing for the self-serve origin.
 * `activateClientProductFromCheckout` (stripe-billing.ts) is what flips
 * 'pending_payment' → 'active' once `checkout.session.completed` arrives.
 * `isProductContracted` only ever matches `status: 'active'`, so a
 * pending or abandoned row never blocks (or falsely allows past) a retry.
 */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const resolved = await resolveClientFromSession();
  if (!resolved) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured || resolved.source !== 'database') {
    return NextResponse.json({ error: 'service_unavailable', detail: 'not_available_in_dev_mode' }, { status: 503 });
  }
  if (!(await isStripeConfigured())) {
    return NextResponse.json({ error: 'service_unavailable', detail: 'stripe_not_configured' }, { status: 503 });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }
  const { productId } = body.data;

  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product || !product.isActive) {
    return NextResponse.json({ error: 'product_not_found' }, { status: 404 });
  }
  // WP-XX — 'web' no longer sells at a fixed catalog price; it goes
  // through the custom-quote flow (POST /api/portal/web-quote/request)
  // instead. The UI should never offer this product here, but reject it
  // explicitly too — defense in depth against a stale client or a
  // direct API call.
  if (product.code === 'web') {
    return NextResponse.json({ error: 'product_requires_quote' }, { status: 400 });
  }

  const client = await prisma.chatbotClient.findUnique({
    where: { id: resolved.clientId },
    select: { id: true, tenantId: true },
  });
  if (!client || !client.tenantId) {
    return NextResponse.json({ error: 'service_unavailable', detail: 'client_has_no_tenant' }, { status: 503 });
  }

  const alreadyContracted = await isProductContracted(prisma, resolved.clientId, product.code);
  if (alreadyContracted) {
    return NextResponse.json({ error: 'already_contracted' }, { status: 409 });
  }

  const isOneTimeOnly = !product.stripeRecurringPriceId;
  if (isOneTimeOnly && product.setupFeeCents === 0) {
    return NextResponse.json({ error: 'product_price_id_missing', productId: product.id }, { status: 404 });
  }
  if (product.setupFeeCents > 0 && !product.stripeSetupPriceId) {
    return NextResponse.json({ error: 'product_setup_price_id_missing', productId: product.id }, { status: 404 });
  }

  const customerId = await ensureCustomerForTenant(client.tenantId);
  if (!customerId) {
    return NextResponse.json({ error: 'service_unavailable', detail: 'stripe_customer_create_failed' }, { status: 503 });
  }

  const existing = await prisma.clientProduct.findUnique({
    where: { clientId_productId: { clientId: resolved.clientId, productId: product.id } },
    select: { status: true },
  });

  const cp = await prisma.$transaction(async (tx) => {
    const row = await tx.clientProduct.upsert({
      where: { clientId_productId: { clientId: resolved.clientId, productId: product.id } },
      create: { clientId: resolved.clientId, productId: product.id, tenantId: client.tenantId!, status: 'pending_payment' },
      update: { status: 'pending_payment', cancelledAt: null },
    });
    await tx.clientProductAudit.create({
      data: {
        clientProductId: row.id,
        clientId: resolved.clientId,
        productId: product.id,
        tenantId: client.tenantId,
        action: 'checkout_started',
        statusBefore: existing?.status ?? null,
        statusAfter: 'pending_payment',
        actorId: `client:${resolved.clientId}`,
      },
    });
    return row;
  });

  const origin = process.env.NEXT_PUBLIC_PORTAL_URL ?? req.nextUrl.origin;
  const successUrl = `${origin}/portal?checkout=success`;
  const cancelUrl = `${origin}/portal/productos?checkout=cancelled`;
  const metadata = {
    kairikos_tenant_id: client.tenantId,
    kairikos_client_id: resolved.clientId,
    kairikos_client_product_id: cp.id,
    kairikos_product_code: product.code,
    kairikos_product_tier: product.tier,
  };

  try {
    const stripe = await getStripe();
    const session = isOneTimeOnly
      ? await stripe.checkout.sessions.create({
          mode: 'payment',
          customer: customerId,
          line_items: [{ price: product.stripeSetupPriceId!, quantity: 1 }],
          invoice_creation: { enabled: true, invoice_data: { metadata } },
          metadata,
          success_url: successUrl,
          cancel_url: cancelUrl,
        })
      : await stripe.checkout.sessions.create({
          mode: 'subscription',
          customer: customerId,
          line_items: [
            { price: product.stripeRecurringPriceId!, quantity: 1 },
            ...(product.stripeSetupPriceId ? [{ price: product.stripeSetupPriceId, quantity: 1 }] : []),
          ],
          subscription_data: { metadata },
          metadata,
          success_url: successUrl,
          cancel_url: cancelUrl,
        });

    if (!session.url) {
      throw new Error('stripe_checkout_session_missing_url');
    }
    return NextResponse.json({ url: session.url }, { status: 200 });
  } catch (err) {
    // The Checkout Session never opened — revert the pending row instead
    // of leaving a ClientProduct stuck in 'pending_payment' with nothing
    // for the client to retry against. `checkout_failed` keeps the
    // attempt visible in the audit trail rather than silently undone.
    await prisma.$transaction(async (tx) => {
      const row = await tx.clientProduct.update({
        where: { id: cp.id },
        data: { status: existing?.status ?? 'cancelled', cancelledAt: existing?.status ? null : new Date() },
      });
      await tx.clientProductAudit.create({
        data: {
          clientProductId: row.id,
          clientId: resolved.clientId,
          productId: product.id,
          tenantId: client.tenantId,
          action: 'checkout_failed',
          statusBefore: 'pending_payment',
          statusAfter: row.status,
          actorId: `client:${resolved.clientId}`,
        },
      });
    });
    // eslint-disable-next-line no-console
    console.error('[POST /api/portal/billing/checkout] stripe session creation failed:', err);
    return NextResponse.json({ error: 'stripe_error' }, { status: 502 });
  }
}
