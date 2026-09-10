import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { getSession } from '@/lib/session';
import { createProductCheckoutSession, type CheckoutSessionError } from '@/lib/stripe-billing';

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
// Traduce el resultado de createProductCheckoutSession al mismo
// contrato HTTP que esta ruta ya tenía documentado arriba, sin que el
// llamante (esta ruta) tenga que conocer los códigos de error uno a uno
// dos veces.
const ERROR_STATUS: Record<CheckoutSessionError, number> = {
  product_not_found: 404,
  product_requires_quote: 400,
  requires_chatbot: 400,
  client_has_no_tenant: 503,
  already_contracted: 409,
  product_price_id_missing: 404,
  product_setup_price_id_missing: 404,
  stripe_not_configured: 503,
  stripe_customer_create_failed: 503,
  stripe_error: 502,
};

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

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  const result = await createProductCheckoutSession({
    clientId: resolved.clientId,
    productId: body.data.productId,
    actorId: `client:${resolved.clientId}`,
  });

  if (!result.ok) {
    const status = ERROR_STATUS[result.error];
    const detail = status === 503 ? { detail: result.error } : {};
    return NextResponse.json({ error: result.error, ...detail, productId: result.productId }, { status });
  }

  return NextResponse.json({ url: result.url }, { status: 200 });
}
