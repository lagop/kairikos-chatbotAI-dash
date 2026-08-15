import 'server-only';
import { prisma } from './prisma';
import { getStripe, isStripeConfigured, StripeUnavailableError } from './stripe';
import type { Prisma } from '@prisma/client';
import type Stripe from 'stripe';

/**
 * KAIA-4262 — Stripe service layer.
 *
 * Encapsulates all interactions with Stripe so the route handlers stay
 * declarative. Idempotent at the data layer:
 *
 *   * Tenant <-> Stripe Customer: linked via Tenant.stripe_customer_id
 *     (UNIQUE). findOrCreateCustomer upserts the Customer and writes
 *     the id back to Tenant.
 *   * ClientProduct <-> Stripe Subscription: linked via
 *     Subscription.stripe_id (UNIQUE) + Subscription.client_product_id
 *     (UNIQUE 1:1). syncSubscriptionFromStripe is upsert by stripe_id.
 *   * Stripe Invoice: linked via Invoice.stripe_id (UNIQUE).
 *     syncInvoiceFromStripe is upsert by stripe_id.
 *
 * Read paths (getBillingForClient, getOwnerOverview) live here too so
 * the route handlers are thin.
 */

function unavailable(): StripeUnavailableError {
  return new StripeUnavailableError();
}

function notConfiguredResponse() {
  return { error: 'service_unavailable' as const, detail: 'stripe_not_configured' };
}

// ---------------------------------------------------------------------------
// Customer
// ---------------------------------------------------------------------------

/**
 * Find or create a Stripe Customer for the tenant.
 *
 * - If the Tenant row already has stripe_customer_id, return it.
 * - Otherwise, create the Customer in Stripe with the tenant metadata,
 *   store the id on Tenant (UPDATE … WHERE id = ? — idempotent under
 *   concurrent calls: only the first UPDATE wins, subsequent callers
 *   re-read the row).
 *
 * Returns the Stripe customer id, or null if Stripe is not configured.
 */
export async function ensureCustomerForTenant(tenantId: string): Promise<string | null> {
  if (!(await isStripeConfigured())) return null;
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, stripeCustomerId: true, name: true, slug: true },
  });
  if (!tenant) throw new Error(`tenant_not_found:${tenantId}`);
  if (tenant.stripeCustomerId) return tenant.stripeCustomerId;

  const stripe = await getStripe();
  const created = await stripe.customers.create({
    name: tenant.name,
    metadata: { kairikos_tenant_id: tenant.id, kairikos_tenant_slug: tenant.slug },
  });
  // Conditional update — only if stripe_customer_id is still NULL.
  // If a concurrent caller already wrote it, the UPDATE matches 0 rows
  // and we re-read to return the canonical id.
  const updated = await prisma.tenant.updateMany({
    where: { id: tenant.id, stripeCustomerId: null },
    data: { stripeCustomerId: created.id },
  });
  if (updated.count === 0) {
    const reread = await prisma.tenant.findUnique({
      where: { id: tenant.id },
      select: { stripeCustomerId: true },
    });
    return reread?.stripeCustomerId ?? created.id;
  }
  return created.id;
}

// ---------------------------------------------------------------------------
// Subscription sync (called from webhook)
// ---------------------------------------------------------------------------

/**
 * Upsert a Subscription row from a Stripe subscription object. Resolves
 * the local ClientProduct via the Stripe subscription.metadata link —
 * the Checkout / billing flow stores kairikos_client_product_id there
 * when creating the Stripe Subscription.
 *
 * Idempotent: the Subscription.stripe_id UNIQUE constraint makes the
 * upsert naturally retry-safe.
 */
export async function syncSubscriptionFromStripe(s: Stripe.Subscription): Promise<void> {
  const cpId = (s.metadata?.kairikos_client_product_id ?? null) as string | null;
  if (!cpId) {
    throw new Error('stripe_subscription_missing_kairikos_client_product_id');
  }
  const clientProduct = await prisma.clientProduct.findUnique({
    where: { id: cpId },
    select: { id: true, clientId: true, tenantId: true, client: { select: { stripeCustomerId: true } } },
  });
  if (!clientProduct) {
    throw new Error(`client_product_not_found:${cpId}`);
  }

  const item = s.items.data[0];
  const priceId = item?.price?.id ?? null;
  const amountCents = item?.price?.unit_amount ?? null;
  const currency = item?.price?.currency ?? 'eur';

  // WP-19 — ClientProduct.tenantId is still nullable pre-WP-09-for-
  // ClientProduct (see that column's own comment). `?? ''` used to
  // insert an empty string into a required @db.Uuid column, which
  // Postgres would reject as invalid UUID syntax anyway — but silently,
  // deep inside a webhook retry loop, instead of a clear error at the
  // one point that actually knows what's wrong. Fail explicitly here.
  if (!clientProduct.tenantId) {
    throw new Error(`client_product_missing_tenant_id:${clientProduct.id}`);
  }

  await prisma.subscription.upsert({
    where: { stripeId: s.id },
    create: {
      tenantId: clientProduct.tenantId,
      clientId: clientProduct.clientId,
      clientProductId: clientProduct.id,
      stripeId: s.id,
      stripeCustomerId: typeof s.customer === 'string' ? s.customer : s.customer.id,
      stripePriceId: priceId,
      status: s.status,
      currentPeriodStart: toDate((s as unknown as { current_period_start?: number }).current_period_start),
      currentPeriodEnd: toDate((s as unknown as { current_period_end?: number }).current_period_end),
      cancelAtPeriodEnd: Boolean(s.cancel_at_period_end),
      canceledAt: toDate(s.canceled_at ?? null),
      amountCents,
      currency,
      metadata: s.metadata as Prisma.InputJsonValue,
    },
    update: {
      status: s.status,
      currentPeriodStart: toDate((s as unknown as { current_period_start?: number }).current_period_start),
      currentPeriodEnd: toDate((s as unknown as { current_period_end?: number }).current_period_end),
      cancelAtPeriodEnd: Boolean(s.cancel_at_period_end),
      canceledAt: toDate(s.canceled_at ?? null),
      stripePriceId: priceId,
      amountCents,
      currency,
      metadata: s.metadata as Prisma.InputJsonValue,
    },
  });
}

/**
 * Delete a Subscription row when the Stripe subscription is removed
 * permanently (canceled + deleted). Soft delete is the safer default —
 * we leave the row for audit unless the caller asks for hard delete.
 */
export async function deleteSubscriptionFromStripe(stripeId: string): Promise<void> {
  await prisma.subscription
    .update({
      where: { stripeId },
      data: { status: 'canceled', canceledAt: new Date() },
    })
    .catch(() => null);
}

// ---------------------------------------------------------------------------
// Invoice sync
// ---------------------------------------------------------------------------

export async function syncInvoiceFromStripe(i: Stripe.Invoice): Promise<void> {
  const subId = typeof i.subscription === 'string' ? i.subscription : i.subscription?.id;

  let tenantId: string;
  let clientId: string;
  let link: { subscriptionId: string; clientProductId: null } | { subscriptionId: null; clientProductId: string };

  if (subId) {
    const subscription = await prisma.subscription.findUnique({
      where: { stripeId: subId },
      select: { id: true, tenantId: true, clientId: true },
    });
    if (!subscription) {
      // Subscription row not yet created. Skip — a subsequent
      // customer.subscription.created event will land first.
      return;
    }
    tenantId = subscription.tenantId;
    clientId = subscription.clientId;
    link = { subscriptionId: subscription.id, clientProductId: null };
  } else {
    // WP-19 — a one-time-purchase invoice (createOneTimeInvoice below)
    // has no Stripe subscription at all. Resolve the ClientProduct via
    // the same kairikos_client_product_id metadata link
    // syncSubscriptionFromStripe uses for subscriptions.
    const cpId = (i.metadata?.kairikos_client_product_id ?? null) as string | null;
    if (!cpId) {
      // Not a Kairikos-created invoice (e.g. a manual one from the
      // Stripe dashboard) — nothing to link it to.
      return;
    }
    const clientProduct = await prisma.clientProduct.findUnique({
      where: { id: cpId },
      select: { id: true, tenantId: true, clientId: true },
    });
    if (!clientProduct) return;
    if (!clientProduct.tenantId) {
      throw new Error(`client_product_missing_tenant_id:${clientProduct.id}`);
    }
    tenantId = clientProduct.tenantId;
    clientId = clientProduct.clientId;
    link = { subscriptionId: null, clientProductId: clientProduct.id };
  }

  await prisma.invoice.upsert({
    where: { stripeId: i.id ?? '' },
    create: {
      tenantId,
      clientId,
      ...link,
      stripeId: i.id ?? '',
      status: i.status ?? 'draft',
      number: i.number ?? null,
      amountDueCents: i.amount_due ?? 0,
      amountPaidCents: i.amount_paid ?? 0,
      currency: i.currency ?? 'eur',
      issuedAt: toDate(i.created),
      dueAt: toDate(i.due_date ?? null),
      paidAt: toDate(i.status === 'paid' ? i.created : null),
      periodStart: toDate(i.period_start ?? null),
      periodEnd: toDate(i.period_end ?? null),
      hostInvoiceUrl: i.hosted_invoice_url ?? null,
      invoicePdfUrl: i.invoice_pdf ?? null,
      metadata: (i.metadata ?? {}) as Prisma.InputJsonValue,
    },
    update: {
      status: i.status ?? 'draft',
      number: i.number ?? null,
      amountDueCents: i.amount_due ?? 0,
      amountPaidCents: i.amount_paid ?? 0,
      paidAt: toDate(i.status === 'paid' ? i.created : null),
      hostInvoiceUrl: i.hosted_invoice_url ?? null,
      invoicePdfUrl: i.invoice_pdf ?? null,
    },
  });
}

/**
 * WP-19 — create + finalize a one-off Stripe Invoice for a one-time-
 * purchase product (no recurring price — e.g. the web platform's pago
 * único). Mirrors the existing subscription checkout's "payment
 * collected out-of-band" shape: `collection_method: 'send_invoice'`
 * makes Stripe email the customer a payment link and starts the invoice
 * as 'open' rather than auto-charging a stored payment method; the
 * `invoice.paid` webhook (already wired in stripe-webhook.ts's dispatch)
 * flips it to 'paid' via syncInvoiceFromStripe above once the client
 * pays.
 *
 * The `kairikos_client_product_id` metadata is what lets
 * syncInvoiceFromStripe resolve this invoice back to a ClientProduct
 * with no Subscription to go through.
 */
export async function createOneTimeInvoice(params: {
  clientProductId: string;
  stripeCustomerId: string;
  stripeSetupPriceId: string;
  metadata: Record<string, string>;
}): Promise<Stripe.Invoice> {
  const stripe = await getStripe();
  const draft = await stripe.invoices.create({
    customer: params.stripeCustomerId,
    collection_method: 'send_invoice',
    days_until_due: 14,
    auto_advance: false,
    metadata: params.metadata,
  });
  await stripe.invoiceItems.create({
    customer: params.stripeCustomerId,
    invoice: draft.id,
    price: params.stripeSetupPriceId,
  });
  return stripe.invoices.finalizeInvoice(draft.id);
}

// ---------------------------------------------------------------------------
// Self-serve checkout (WP-30) — activate/expire a ClientProduct created in
// 'pending_payment' state by POST /api/portal/billing/checkout, driven by
// the Checkout Session's own lifecycle events.
// ---------------------------------------------------------------------------

/**
 * `checkout.session.completed` — flips the ClientProduct the checkout
 * route pre-created (status='pending_payment') to 'active'. Guarded on
 * the current status still being 'pending_payment' so a duplicate/
 * out-of-order webhook delivery, or a session that completes after an
 * operator has already changed the row some other way, is a no-op rather
 * than clobbering state. Not every Checkout Session is a Kairikos
 * self-serve one (there is exactly one caller today, but Stripe accounts
 * can have other sessions), so a missing `kairikos_client_product_id` is
 * silently ignored, not an error.
 */
export async function activateClientProductFromCheckout(session: Stripe.Checkout.Session): Promise<void> {
  const cpId = (session.metadata?.kairikos_client_product_id ?? null) as string | null;
  if (!cpId) return;
  const cp = await prisma.clientProduct.findUnique({ where: { id: cpId }, select: { status: true } });
  if (!cp || cp.status !== 'pending_payment') return;

  await prisma.$transaction(async (tx) => {
    const updated = await tx.clientProduct.update({
      where: { id: cpId },
      data: { status: 'active', subscribedAt: new Date() },
    });
    await tx.clientProductAudit.create({
      data: {
        clientProductId: updated.id,
        clientId: updated.clientId,
        productId: updated.productId,
        tenantId: updated.tenantId,
        action: 'checkout_completed',
        statusBefore: 'pending_payment',
        statusAfter: 'active',
        actorId: 'stripe:checkout.session.completed',
      },
    });
  });
}

/**
 * `checkout.session.expired` — Stripe fires this when a session's payment
 * page is abandoned (no completion within its expiry window, ~24h by
 * default). Flips the pending ClientProduct to 'cancelled' rather than
 * leaving it stuck in 'pending_payment' forever — the AC this satisfies:
 * a failed/abandoned checkout must not leave the client in an ambiguous
 * half-activated state. `isProductContracted` (status='active' only)
 * already treats 'pending_payment' as "not contracted", so the client can
 * simply retry from /portal/productos without waiting for this event —
 * this is cleanup, not a blocker.
 */
export async function expireClientProductFromCheckout(session: Stripe.Checkout.Session): Promise<void> {
  const cpId = (session.metadata?.kairikos_client_product_id ?? null) as string | null;
  if (!cpId) return;
  const cp = await prisma.clientProduct.findUnique({ where: { id: cpId }, select: { status: true } });
  if (!cp || cp.status !== 'pending_payment') return;

  await prisma.$transaction(async (tx) => {
    const updated = await tx.clientProduct.update({
      where: { id: cpId },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });
    await tx.clientProductAudit.create({
      data: {
        clientProductId: updated.id,
        clientId: updated.clientId,
        productId: updated.productId,
        tenantId: updated.tenantId,
        action: 'checkout_expired',
        statusBefore: 'pending_payment',
        statusAfter: 'cancelled',
        actorId: 'stripe:checkout.session.expired',
      },
    });
  });
}

// ---------------------------------------------------------------------------
// Read paths — billing for client (single tenant) and overview for owner
// ---------------------------------------------------------------------------

export interface ClientBillingSummary {
  tenantId: string | null;
  customer: {
    stripeCustomerId: string | null;
    portalUrl: string | null;
  };
  subscriptions: Array<{
    id: string;
    clientProductId: string;
    status: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    product: { name: string; tier: string; priceCents: number; currency: string };
  }>;
  // WP-19 — a ClientProduct for a one-time-purchase product (no
  // recurring price) never gets a Subscription row, so it's invisible
  // in `subscriptions` above. Surfaced separately here so the client can
  // see and audit N ClientProducts total (recurring + one-time), not
  // just the recurring ones — AC: "la página de facturación los
  // desglosa".
  oneTimePurchases: Array<{
    clientProductId: string;
    product: { name: string; tier: string; setupFeeCents: number; currency: string };
    invoice: {
      status: string;
      amountDueCents: number;
      amountPaidCents: number;
      issuedAt: string | null;
      paidAt: string | null;
      invoicePdfUrl: string | null;
      hostInvoiceUrl: string | null;
    } | null;
  }>;
  upcomingInvoice: { amountDueCents: number; currency: string; dueAt: string | null } | null;
  recentInvoices: Array<{
    id: string;
    number: string | null;
    status: string;
    amountDueCents: number;
    amountPaidCents: number;
    currency: string;
    issuedAt: string | null;
    paidAt: string | null;
    invoicePdfUrl: string | null;
    hostInvoiceUrl: string | null;
  }>;
}

export async function getBillingForClient(clientId: string): Promise<ClientBillingSummary | null> {
  const client = await prisma.chatbotClient.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      tenantId: true,
      stripeCustomerId: true,
      clientProducts: {
        where: { status: { in: ['active', 'paused'] } },
        orderBy: { subscribedAt: 'asc' },
        include: {
          product: { select: { name: true, tier: true, priceCents: true, setupFeeCents: true, currency: true } },
          subscription: true,
          // WP-19 — one-time-purchase ClientProducts have no
          // subscription; `take: 1` + newest-first picks the latest
          // attempt if a client somehow has more than one invoice here
          // (e.g. a failed one followed by a retry).
          invoices: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      },
    },
  });
  if (!client) return null;

  const stripeCustomerId = client.stripeCustomerId;
  const portalUrl = stripeCustomerId && (await isStripeConfigured())
    ? await getCustomerPortalUrl(stripeCustomerId)
    : null;

  const subscriptions = client.clientProducts
    .filter((cp) => cp.subscription)
    .map((cp) => ({
      id: cp.subscription!.id,
      clientProductId: cp.id,
      status: cp.subscription!.status,
      currentPeriodEnd: cp.subscription!.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: cp.subscription!.cancelAtPeriodEnd,
      product: cp.product,
    }));

  // WP-19 — the complement of `subscriptions`: ClientProducts with no
  // Subscription row are, by construction, the one-time-purchase ones.
  const oneTimePurchases = client.clientProducts
    .filter((cp) => !cp.subscription)
    .map((cp) => {
      const invoice = cp.invoices[0];
      return {
        clientProductId: cp.id,
        product: cp.product,
        invoice: invoice
          ? {
              status: invoice.status,
              amountDueCents: invoice.amountDueCents,
              amountPaidCents: invoice.amountPaidCents,
              issuedAt: invoice.issuedAt?.toISOString() ?? null,
              paidAt: invoice.paidAt?.toISOString() ?? null,
              invoicePdfUrl: invoice.invoicePdfUrl,
              hostInvoiceUrl: invoice.hostInvoiceUrl,
            }
          : null,
      };
    });

  const latestInvoice = await prisma.invoice.findFirst({
    where: { clientId: client.id },
    orderBy: { issuedAt: 'desc' },
    select: { id: true, number: true, status: true, amountDueCents: true, amountPaidCents: true, currency: true, issuedAt: true, paidAt: true, invoicePdfUrl: true, hostInvoiceUrl: true },
  });

  const upcoming = subscriptions
    .filter((s) => s.status === 'active' || s.status === 'trialing')
    .map((s) => ({
      amountDueCents: s.product.priceCents,
      currency: s.product.currency,
      dueAt: s.currentPeriodEnd,
    }))
    .reduce<{ amountDueCents: number; currency: string; dueAt: string | null } | null>(
      (acc, cur) => {
        if (!acc) return cur;
        return {
          amountDueCents: acc.amountDueCents + cur.amountDueCents,
          currency: cur.currency,
          dueAt: cur.dueAt && (!acc.dueAt || cur.dueAt > acc.dueAt) ? cur.dueAt : acc.dueAt,
        };
      },
      null,
    );

  const recent = await prisma.invoice.findMany({
    where: { clientId: client.id },
    orderBy: { issuedAt: 'desc' },
    take: 12,
    select: { id: true, number: true, status: true, amountDueCents: true, amountPaidCents: true, currency: true, issuedAt: true, paidAt: true, invoicePdfUrl: true, hostInvoiceUrl: true },
  });

  return {
    tenantId: client.tenantId,
    customer: { stripeCustomerId, portalUrl },
    subscriptions,
    oneTimePurchases,
    upcomingInvoice: upcoming,
    recentInvoices: recent.map((i) => ({
      id: i.id,
      number: i.number,
      status: i.status,
      amountDueCents: i.amountDueCents,
      amountPaidCents: i.amountPaidCents,
      currency: i.currency,
      issuedAt: i.issuedAt?.toISOString() ?? null,
      paidAt: i.paidAt?.toISOString() ?? null,
      invoicePdfUrl: i.invoicePdfUrl,
      hostInvoiceUrl: i.hostInvoiceUrl,
    })),
  };
}

/**
 * MRR aggregation by product for the owner dashboard. Returns one row
 * per active Subscription, summed per product tier. Also returns the
 * subscriptions expiring in the next 14 days and the recent
 * cancellations.
 */
export interface OwnerBillingOverview {
  // WP-12 — keyed by Product.id, not by tier: tier is only unique WITHIN a
  // product's code now (Product.@@unique([code, tier])), so two different
  // products can share the same tier string (e.g. a hypothetical 'pro' on
  // both chatbot and web) without their MRR silently merging under one key.
  mrrByProductCents: Record<string, { productCode: string; productName: string; tier: string; mrrCents: number; activeSubscriptions: number }>;
  mrrTotalCents: number;
  expiringSoon: Array<{
    subscriptionId: string;
    clientId: string;
    clientName: string;
    productName: string;
    tier: string;
    currentPeriodEnd: string;
    amountCents: number | null;
  }>;
  recentCancellations: Array<{
    subscriptionId: string;
    clientId: string;
    clientName: string;
    productName: string;
    canceledAt: string;
  }>;
}

export async function getOwnerBillingOverview(): Promise<OwnerBillingOverview> {
  const now = new Date();
  const in14d = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  const active = await prisma.subscription.findMany({
    where: { status: { in: ['active', 'trialing'] } },
    include: {
      client: { select: { id: true, name: true, companyName: true } },
      clientProduct: { include: { product: { select: { code: true, tier: true, name: true, priceCents: true } } } },
    },
  });

  const expiring = await prisma.subscription.findMany({
    where: {
      status: { in: ['active', 'trialing'] },
      currentPeriodEnd: { gte: now, lte: in14d },
    },
    orderBy: { currentPeriodEnd: 'asc' },
    include: {
      client: { select: { id: true, name: true, companyName: true } },
      clientProduct: { include: { product: { select: { code: true, tier: true, name: true, priceCents: true } } } },
    },
  });

  const recentCancellations = await prisma.subscription.findMany({
    where: { status: 'canceled', canceledAt: { gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) } },
    orderBy: { canceledAt: 'desc' },
    take: 20,
    include: {
      client: { select: { id: true, name: true, companyName: true } },
      clientProduct: { include: { product: { select: { code: true, tier: true, name: true } } } },
    },
  });

  const mrrByProductCents: OwnerBillingOverview['mrrByProductCents'] = {};
  let mrrTotalCents = 0;
  for (const s of active) {
    // Key by productId, not tier — WP-12 made tier unique only within a
    // product's code, so two different products can share a tier string.
    const key = s.clientProduct.productId;
    const { code, tier, name } = s.clientProduct.product;
    const amount = s.amountCents ?? s.clientProduct.product.priceCents;
    if (!mrrByProductCents[key]) {
      mrrByProductCents[key] = { productCode: code, productName: name, tier, mrrCents: 0, activeSubscriptions: 0 };
    }
    mrrByProductCents[key].mrrCents += amount;
    mrrByProductCents[key].activeSubscriptions += 1;
    mrrTotalCents += amount;
  }

  return {
    mrrByProductCents,
    mrrTotalCents,
    expiringSoon: expiring.map((s) => ({
      subscriptionId: s.id,
      clientId: s.clientId,
      clientName: s.client.companyName ?? s.client.name,
      productName: s.clientProduct.product.name,
      tier: s.clientProduct.product.tier,
      currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? '',
      amountCents: s.amountCents ?? s.clientProduct.product.priceCents,
    })),
    recentCancellations: recentCancellations.map((s) => ({
      subscriptionId: s.id,
      clientId: s.clientId,
      clientName: s.client.companyName ?? s.client.name,
      productName: s.clientProduct.product.name,
      canceledAt: s.canceledAt?.toISOString() ?? '',
    })),
  };
}

/**
 * Stripe-hosted Billing Portal URL for a Stripe customer. Used by the
 * client billing UI's "Manage payment method" button.
 */
async function getCustomerPortalUrl(stripeCustomerId: string): Promise<string | null> {
  if (!(await isStripeConfigured())) return null;
  const stripe = await getStripe();
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: process.env.NEXT_PUBLIC_PORTAL_URL
        ? `${process.env.NEXT_PUBLIC_PORTAL_URL}/portal/billing`
        : undefined,
    });
    return session.url;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function toDate(epochSeconds: number | null | undefined): Date | null {
  if (epochSeconds == null) return null;
  return new Date(epochSeconds * 1000);
}

export { notConfiguredResponse, unavailable };
