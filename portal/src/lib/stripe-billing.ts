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
  if (!isStripeConfigured()) return null;
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, stripeCustomerId: true, name: true, slug: true },
  });
  if (!tenant) throw new Error(`tenant_not_found:${tenantId}`);
  if (tenant.stripeCustomerId) return tenant.stripeCustomerId;

  const stripe = getStripe();
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

  await prisma.subscription.upsert({
    where: { stripeId: s.id },
    create: {
      tenantId: clientProduct.tenantId ?? '',
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
  if (!subId) {
    // Not all invoices are tied to a subscription (e.g. one-off
    // invoices). Skip — we only persist subscription-linked invoices.
    return;
  }
  const subscription = await prisma.subscription.findUnique({
    where: { stripeId: subId },
    select: { id: true, tenantId: true, clientId: true },
  });
  if (!subscription) {
    // Subscription row not yet created. Skip — a subsequent
    // customer.subscription.created event will land first.
    return;
  }
  await prisma.invoice.upsert({
    where: { stripeId: i.id ?? '' },
    create: {
      tenantId: subscription.tenantId,
      clientId: subscription.clientId,
      subscriptionId: subscription.id,
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
          product: { select: { name: true, tier: true, priceCents: true, currency: true } },
          subscription: true,
        },
      },
    },
  });
  if (!client) return null;

  const stripeCustomerId = client.stripeCustomerId;
  const portalUrl = stripeCustomerId && isStripeConfigured()
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
  mrrByProductCents: Record<string, { productName: string; tier: string; mrrCents: number; activeSubscriptions: number }>;
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
      clientProduct: { include: { product: { select: { tier: true, name: true, priceCents: true } } } },
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
      clientProduct: { include: { product: { select: { tier: true, name: true, priceCents: true } } } },
    },
  });

  const recentCancellations = await prisma.subscription.findMany({
    where: { status: 'canceled', canceledAt: { gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) } },
    orderBy: { canceledAt: 'desc' },
    take: 20,
    include: {
      client: { select: { id: true, name: true, companyName: true } },
      clientProduct: { include: { product: { select: { tier: true, name: true } } } },
    },
  });

  const mrrByProductCents: OwnerBillingOverview['mrrByProductCents'] = {};
  let mrrTotalCents = 0;
  for (const s of active) {
    const tier = s.clientProduct.product.tier;
    const amount = s.amountCents ?? s.clientProduct.product.priceCents;
    if (!mrrByProductCents[tier]) {
      mrrByProductCents[tier] = { productName: s.clientProduct.product.name, tier, mrrCents: 0, activeSubscriptions: 0 };
    }
    mrrByProductCents[tier].mrrCents += amount;
    mrrByProductCents[tier].activeSubscriptions += 1;
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
  if (!isStripeConfigured()) return null;
  const stripe = getStripe();
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: process.env.NEXT_PUBLIC_PORTAL_URL
        ? `${process.env.NEXT_PUBLIC_PORTAL_URL}/portal/facturacion`
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

function toDate(epochSeconds: number | null | undefined): Date | null {
  if (epochSeconds == null) return null;
  return new Date(epochSeconds * 1000);
}

export { notConfiguredResponse, unavailable };
