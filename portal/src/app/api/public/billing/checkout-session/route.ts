import { NextResponse, type NextRequest } from 'next/server';
import { createHash, randomUUID } from 'node:crypto';
import { CheckoutRequestSchema } from '@/lib/onboarding/schemas';
import {
  getOnboardingSession,
  markCheckoutStarted,
  updateOnboardingSession,
} from '@/lib/onboarding/sessions';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getStripe, isStripeConfigured } from '@/lib/stripe';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// POST /api/public/billing/checkout-session — KAIA-4263
//
// Public endpoint that creates a Stripe Checkout Session for a self-serve
// onboarding flow. Body matches the CheckoutRequestSchema.
//
// Behaviour:
//   1. Validate the body + resolve the OnboardingSession.
//   2. Resolve the Product row for the requested tier (must have a
//      stripePriceId). 404 otherwise.
//   3. Resolve or create the ClientProduct row for the prospective
//      tenant (status='onboarding'). The Stripe webhook flips this
//      to 'active' on payment success (KAIA-4262 contract).
//   4. Ensure the Stripe Customer exists (idempotent on
//      Tenant.stripe_customer_id — relies on Backend Developer having
//      settled the canonical creation; for the local-only path this
//      endpoint leaves the customer id in OnboardingSession.stripeCustomerId).
//   5. Create the Stripe Checkout Session with metadata carrying the
//      wizard session id so the webhook can correlate payment →
//      onboarding session.
//   6. Mark the OnboardingSession as checkout_pending and return the
//      checkout URL + clientProductId so the React wizard can redirect.
//
// KAIA-10264 (H3): every step downstream of schema validation is wrapped
// in a single try/catch so an unexpected throw (e.g. Stripe rejecting
// the customer, a transient Prisma error, an invalid metadata value)
// returns `{ error: 'service_unavailable', detail }` with HTTP 500
// instead of Next.js' default empty-body 500. That gives the wizard
// enough context to surface a useful error and gives QA / logs a
// reproducible failure payload.
//
// Responses:
//   200 { checkoutUrl, clientProductId, stripeSessionId }
//   400 { error: 'invalid_body', details }
//   404 { error: 'session_not_found' | 'product_not_found' | 'price_id_missing' }
//   500 { error: 'service_unavailable', detail }   // KAIA-10264
//   503 { error: 'service_unavailable', detail }
// =============================================================================

function ensureSlug(candidate: string, fallback: string): string {
  const cleaned = candidate.replace(/[^a-z0-9-]/gi, '').slice(0, 32).toLowerCase();
  return cleaned || fallback;
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const parsed = CheckoutRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    return await handleCheckout(parsed.data);
  } catch (err) {
    // KAIA-10264 (H3): surface the underlying failure in the JSON body
    // so the wizard can render a useful message and QA / log search can
    // reproduce the failure without scraping empty responses.
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: 'service_unavailable', detail },
      { status: 500 },
    );
  }
}

async function handleCheckout(
  parsed: {
    sessionId: string;
    productTier: 'starter' | 'pro' | 'premium';
    email: string;
    config: {
      businessName: string;
      sector: string;
      whatsapp?: string;
      contactEmail?: string;
    };
  },
) {
  if (!isStripeConfigured()) {
    return NextResponse.json(
      { error: 'service_unavailable', detail: 'stripe_not_configured' },
      { status: 503 },
    );
  }

  const session = await getOnboardingSession(parsed.sessionId);
  if (!session) {
    return NextResponse.json({ error: 'session_not_found' }, { status: 404 });
  }

  if (!isDatabaseConfigured) {
    return NextResponse.json(
      { error: 'service_unavailable', detail: 'database_not_configured' },
      { status: 503 },
    );
  }

  // Resolve the Product row.
  const product = await prisma.product.findUnique({
    where: { tier: parsed.productTier },
    select: { id: true, name: true, tier: true, stripePriceId: true, priceCents: true, currency: true },
  });
  if (!product) {
    return NextResponse.json({ error: 'product_not_found' }, { status: 404 });
  }
  if (!product.stripePriceId) {
    return NextResponse.json(
      { error: 'price_id_missing', detail: `product ${product.tier} has no stripe_price_id` },
      { status: 404 },
    );
  }

  // Ensure Tenant + a placeholder ChatbotClient so the canonical
  // ClientProduct row points to a valid client_id. Backend Developer
  // will take over once the canonical creation flow ships; for now
  // this is a local tenant stub.
  let tenant = await prisma.tenant.findUnique({
    where: { slug: session.tenantSlug },
    select: { id: true, stripeCustomerId: true },
  });
  if (!tenant) {
    tenant = await prisma.tenant.create({
      data: {
        name: parsed.config.businessName,
        slug: ensureSlug(session.tenantSlug, 'kairikos-' + createHash('sha1').update(session.tenantSlug).digest('hex').slice(0, 6)),
      },
      select: { id: true, stripeCustomerId: true },
    });
  }

  let client = await prisma.chatbotClient.findFirst({
    where: { tenantId: tenant.id, email: parsed.email },
    select: { id: true, supabaseClientId: true },
  });

  // clientId for ClientProduct must be a UUID (public.client_products.client_id is uuid).
  // ChatbotClient.supabaseClientId stores the UUID link to snake_case chatbot_clients.
  // Populate it if not yet set so the FK constraint is satisfied.
  let supabaseClientUuid: string;
  if (!client) {
    const created = await prisma.chatbotClient.create({
      data: {
        tenantId: tenant.id,
        email: parsed.email,
        name: parsed.config.businessName,
        tier: parsed.productTier,
        state: 'in-progress',
      },
      select: { id: true },
    });
    supabaseClientUuid = randomUUID();
    await prisma.chatbotClient.update({
      where: { id: created.id },
      data: { supabaseClientId: supabaseClientUuid },
    });
    client = { id: created.id, supabaseClientId: supabaseClientUuid };
  } else {
    if (!client.supabaseClientId) {
      supabaseClientUuid = randomUUID();
      await prisma.chatbotClient.update({
        where: { id: client.id },
        data: { supabaseClientId: supabaseClientUuid },
      });
    } else {
      supabaseClientUuid = client.supabaseClientId;
    }
  }

  // Find or create the ClientProduct row for this (client, product) pair.
  // clientId must be the UUID from ChatbotClientPublic (snake_case chatbot_clients),
  // NOT the PascalCase ChatbotClient cuid — public.client_products.client_id is uuid.
  const existingCp = await prisma.clientProduct.findUnique({
    where: { clientId_productId: { clientId: supabaseClientUuid, productId: product.id } },
    select: { id: true },
  });
  const clientProduct = existingCp
    ? existingCp
      : await prisma.clientProduct.create({
        data: {
          tenantId: tenant.id,
          clientId: supabaseClientUuid,
          productId: product.id,
          status: 'active',
        },
        select: { id: true },
      });

  await updateOnboardingSession(parsed.sessionId, {
    productId: product.id,
    productTier: parsed.productTier,
    businessName: parsed.config.businessName,
    sector: parsed.config.sector,
    whatsapp: parsed.config.whatsapp ?? null,
    contactEmail: parsed.config.contactEmail ?? null,
  });

  // Resolve or create Stripe customer.
  let stripeCustomerId = tenant.stripeCustomerId;
  const stripe = getStripe();
  if (!stripeCustomerId) {
    const created = await stripe.customers.create({
      email: parsed.email,
      name: parsed.config.businessName,
      metadata: {
        kairikos_tenant_id: tenant.id,
        kairikos_onboarding_session: session.sessionToken,
        kairikos_product_tier: parsed.productTier,
      },
    });
    stripeCustomerId = created.id;
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { stripeCustomerId },
    });
  }

  const baseUrl =
    process.env.NEXT_PUBLIC_PORTAL_URL ?? 'https://portal.kairikos.com';

  const checkout = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: stripeCustomerId,
    line_items: [{ price: product.stripePriceId, quantity: 1 }],
    success_url: `${baseUrl}/onboarding/activado?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/onboarding/pago?canceled=1`,
    metadata: {
      kairikos_tenant_id: tenant.id,
      kairikos_client_id: client.id,
      kairikos_client_product_id: clientProduct.id,
      kairikos_onboarding_session: session.sessionToken,
      kairikos_product_tier: parsed.productTier,
    },
    allow_promotion_codes: true,
  });

  if (!checkout.url || !checkout.id) {
    return NextResponse.json(
      { error: 'service_unavailable', detail: 'stripe_session_missing_url' },
      { status: 503 },
    );
  }

  await markCheckoutStarted(parsed.sessionId, {
    productId: product.id,
    productTier: parsed.productTier,
    clientProductId: clientProduct.id,
    stripeCheckoutSessionId: checkout.id,
    businessName: parsed.config.businessName,
    sector: parsed.config.sector,
    whatsapp: parsed.config.whatsapp ?? null,
    contactEmail: parsed.config.contactEmail ?? null,
    stripeCustomerId,
  });

  return NextResponse.json({
    checkoutUrl: checkout.url,
    clientProductId: clientProduct.id,
    stripeSessionId: checkout.id,
  });
}
