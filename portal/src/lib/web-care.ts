import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { resolveContractedInstance } from './client-product-access';
import { assignSiteToNewContract } from './client-site';
import { createProductCheckoutSession, ensureCustomerForTenant, type CreateCheckoutSessionResult } from './stripe-billing';
import { getStripe, isStripeConfigured } from './stripe';
import { findCustomCareOffer, firstChargeDate, type CustomCareOffer } from './custom-care';
import { annualPriceCents } from './annual-billing';
import type { BillingInterval } from './annual-billing';

// =============================================================================
// Plan de precios del 01/10/2026 — Cuidado de la web.
//
// Alojamiento, dominio, copias y cambios pequeños, por 29 €/mes o 290 €/año.
// La web (799 €) lleva el primer año de dominio y alojamiento incluido; el
// Cuidado se contrata desde el segundo año, o desde el primer mes si el
// cliente quiere cambios.
//
// Es un complemento (Product.kind 'addon') y va POR WEB: un cliente con dos
// webs paga dos, porque cada alojamiento es un coste (la regla del coste
// marginal de CLAUDE.md). Por eso 'web_care' está en
// MULTI_INSTANCE_PRODUCT_CODES y cada contratación lleva el clientSiteId de su
// web desde el momento del pago: assignSiteToNewContract no toca una
// contratación que ya tiene sitio, así que no puede acabar en otra web.
//
// Lo que se presta (renovar el dominio, las copias, los cambios) lo hace el
// operador: este código cobra y deja constancia, no automatiza el servicio.
// =============================================================================

export const WEB_CARE_CODE = 'web_care';

export interface WebCareState {
  /** Null si el complemento no está a la venta (aún no creado en Stripe). */
  offer: {
    productId: string;
    priceCents: number;
    /** Null mientras no tenga precio anual en Stripe. */
    annualPriceCents: number | null;
    currency: string;
  } | null;
  /** El Cuidado de ESTA web, si lo tiene. customPriceCents: el precio pactado,
   *  si es un mantenimiento a medida (lib/custom-care.ts). */
  contract: {
    clientProductId: string;
    status: string;
    billingInterval: string | null;
    customPriceCents: number | null;
    /** Cuándo cobra Stripe la próxima vez (el fin del periodo sin cobrar, si lo hay). */
    nextChargeAt: string | null;
  } | null;
  /** 11/11/2026 — mantenimiento a medida pendiente de activar. Si lo hay, la
   *  página enseña ESTA oferta y no la del catálogo. */
  customOffer: CustomCareOffer | null;
}

/** Lo que la página de una web necesita para enseñar el Cuidado. */
export async function getWebCareState(
  prisma: PrismaClient,
  clientId: string,
  webClientSiteId: string | null,
): Promise<WebCareState> {
  const [product, contract] = await Promise.all([
    prisma.product.findFirst({
      where: { code: WEB_CARE_CODE, kind: 'addon', isActive: true },
      select: { id: true, priceCents: true, currency: true, stripeRecurringPriceId: true, stripeAnnualPriceId: true },
    }),
    webClientSiteId
      ? prisma.clientProduct.findFirst({
          where: {
            clientId,
            clientSiteId: webClientSiteId,
            status: { in: ['active', 'paused'] },
            product: { code: WEB_CARE_CODE },
          },
          select: {
            id: true,
            status: true,
            customPriceCents: true,
            subscription: { select: { billingInterval: true, currentPeriodEnd: true } },
          },
        })
      : null,
  ]);
  const customOffer = webClientSiteId && !contract ? await findCustomCareOffer(prisma, clientId, webClientSiteId) : null;
  return {
    offer:
      product && product.stripeRecurringPriceId
        ? {
            productId: product.id,
            priceCents: product.priceCents,
            annualPriceCents: product.stripeAnnualPriceId ? annualPriceCents(product.priceCents) : null,
            currency: product.currency,
          }
        : null,
    contract: contract
      ? {
          clientProductId: contract.id,
          status: contract.status,
          billingInterval: contract.subscription?.billingInterval ?? null,
          customPriceCents: contract.customPriceCents,
          nextChargeAt: contract.subscription?.currentPeriodEnd?.toISOString() ?? null,
        }
      : null,
    customOffer,
  };
}

export type WebCareCheckoutResult =
  | CreateCheckoutSessionResult
  | { ok: false; error: 'web_not_found' | 'care_not_on_sale' | 'already_contracted' };

export async function createWebCareCheckout(
  prisma: PrismaClient,
  params: { clientId: string; webClientProductId: string; billing: BillingInterval; actorId: string },
): Promise<WebCareCheckoutResult> {
  // La web se resuelve contra el cliente de la sesión, y tiene que estar
  // activa (pagada): el Cuidado de una web que aún es un presupuesto no
  // tiene nada que cuidar.
  const web = await resolveContractedInstance(prisma, {
    clientId: params.clientId,
    productCode: 'web',
    clientProductId: params.webClientProductId,
  });
  if (!web) return { ok: false, error: 'web_not_found' };

  // Una web antigua puede no tener sitio todavía: se le asigna aquí, igual
  // que lo haría su activación.
  const clientSiteId =
    web.clientSiteId ??
    (
      await assignSiteToNewContract(prisma, {
        clientId: web.clientId,
        tenantId: web.tenantId,
        clientProductId: web.clientProductId,
        productCode: 'web',
      })
    ).clientSiteId;

  const product = await prisma.product.findFirst({
    where: { code: WEB_CARE_CODE, kind: 'addon', isActive: true },
    select: { id: true, stripeRecurringPriceId: true },
  });
  if (!product?.stripeRecurringPriceId) return { ok: false, error: 'care_not_on_sale' };

  // Uno por web. Un pago pendiente no cuenta: reintentarlo es legítimo, y
  // createProductCheckoutSession reaprovecha esa misma fila.
  const already = await prisma.clientProduct.findFirst({
    where: {
      clientId: params.clientId,
      clientSiteId,
      status: { in: ['active', 'paused'] },
      product: { code: WEB_CARE_CODE },
    },
    select: { id: true },
  });
  if (already) return { ok: false, error: 'already_contracted' };

  return createProductCheckoutSession({
    clientId: params.clientId,
    productId: product.id,
    actorId: params.actorId,
    billing: params.billing,
    clientSiteId,
    returnPath: `/portal/web/${web.clientProductId}`,
  });
}

// =============================================================================
// 11/11/2026 — activar el mantenimiento a medida (lib/custom-care.ts).
//
// Una Checkout Session de suscripción con el precio pactado escrito en la
// propia línea (price_data sobre el Stripe Product del Cuidado), no con el
// precio del catálogo: así no hay que crear un Price en Stripe por cliente.
// Los meses sin cobrar son el periodo de prueba (subscription_data.trial_end):
// Stripe guarda la tarjeta ahora y cobra la primera cuota ese día, solo.
//
// La activación es la de siempre: checkout.session.completed pasa la fila de
// 'pending_payment' a 'active' (activateClientProductFromCheckout), y la
// suscripción, en 'trialing' mientras no cobra, se sincroniza por su
// metadata. Si el cliente abandona el pago, la oferta NO se cancela
// (expireClientProductFromCheckout la respeta): sigue ahí para reintentarlo.
// =============================================================================

/** Stripe rechaza un trial_end a más de 730 días. 24 meses pueden ser 731 si
 *  hay un 29 de febrero por medio: se recorta a 729 para no rozar el límite. */
const STRIPE_MAX_TRIAL_MS = 729 * 24 * 60 * 60 * 1000;

export type CustomCareCheckoutResult =
  | { ok: true; url: string }
  | {
      ok: false;
      error:
        | 'web_not_found'
        | 'offer_not_found'
        | 'care_not_on_sale'
        | 'stripe_not_configured'
        | 'client_has_no_tenant'
        | 'stripe_customer_create_failed'
        | 'stripe_error';
    };

/** Cuándo empieza a cobrar Stripe si el cliente activa la oferta en `now`. */
export function customCareTrialEnd(now: Date, trialMonths: number): Date | null {
  if (trialMonths <= 0) return null;
  return new Date(Math.min(firstChargeDate(now, trialMonths).getTime(), now.getTime() + STRIPE_MAX_TRIAL_MS));
}

export async function createCustomCareCheckout(
  prisma: PrismaClient,
  params: { clientId: string; webClientProductId: string; actorId: string; now?: Date },
): Promise<CustomCareCheckoutResult> {
  const web = await resolveContractedInstance(prisma, {
    clientId: params.clientId,
    productCode: 'web',
    clientProductId: params.webClientProductId,
  });
  if (!web) return { ok: false, error: 'web_not_found' };
  // Sin sitio no puede haber oferta: las ofertas nacen con el de su web.
  if (!web.clientSiteId) return { ok: false, error: 'offer_not_found' };

  const offer = await findCustomCareOffer(prisma, params.clientId, web.clientSiteId);
  if (!offer) return { ok: false, error: 'offer_not_found' };

  if (!(await isStripeConfigured())) return { ok: false, error: 'stripe_not_configured' };
  const product = await prisma.product.findFirst({
    where: { code: WEB_CARE_CODE, kind: 'addon', isActive: true },
    select: { id: true, stripeProductId: true, tier: true },
  });
  if (!product?.stripeProductId) return { ok: false, error: 'care_not_on_sale' };

  const client = await prisma.chatbotClient.findUnique({ where: { id: params.clientId }, select: { tenantId: true } });
  if (!client?.tenantId) return { ok: false, error: 'client_has_no_tenant' };
  const customerId = await ensureCustomerForTenant(client.tenantId);
  if (!customerId) return { ok: false, error: 'stripe_customer_create_failed' };

  const trialEnd = customCareTrialEnd(params.now ?? new Date(), offer.trialMonths);
  const metadata = {
    kairikos_tenant_id: client.tenantId,
    kairikos_client_id: params.clientId,
    kairikos_client_product_id: offer.clientProductId,
    kairikos_product_code: WEB_CARE_CODE,
    kairikos_product_tier: product.tier,
    kairikos_billing_interval: 'monthly',
    kairikos_custom_price_cents: String(offer.priceCents),
  };
  const origin = process.env.NEXT_PUBLIC_PORTAL_URL ?? 'http://localhost:3001';
  const returnPath = `/portal/web/${web.clientProductId}`;

  try {
    const stripe = await getStripe();
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [
        {
          price_data: {
            currency: offer.currency.toLowerCase(),
            product: product.stripeProductId,
            unit_amount: offer.priceCents,
            recurring: { interval: 'month' },
          },
          quantity: 1,
        },
      ],
      subscription_data: {
        metadata,
        ...(trialEnd ? { trial_end: Math.floor(trialEnd.getTime() / 1000) } : {}),
      },
      // Con periodo sin cobrar, Stripe puede no pedir tarjeta: la primera
      // cuota fallaría dentro de un año sin que nadie lo viera venir.
      payment_method_collection: 'always',
      metadata,
      success_url: `${origin}${returnPath}?checkout=success`,
      cancel_url: `${origin}${returnPath}?checkout=cancelled`,
    });
    if (!session.url) throw new Error('stripe_checkout_session_missing_url');
    await prisma.clientProductAudit.create({
      data: {
        clientProductId: offer.clientProductId,
        clientId: params.clientId,
        productId: product.id,
        tenantId: client.tenantId,
        action: 'checkout_started',
        statusBefore: 'pending_payment',
        statusAfter: 'pending_payment',
        actorId: params.actorId,
      },
    });
    return { ok: true, url: session.url };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[createCustomCareCheckout] stripe session creation failed:', err);
    return { ok: false, error: 'stripe_error' };
  }
}
