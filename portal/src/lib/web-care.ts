import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { resolveContractedInstance } from './client-product-access';
import { assignSiteToNewContract } from './client-site';
import { createProductCheckoutSession, type CreateCheckoutSessionResult } from './stripe-billing';
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
  /** El Cuidado de ESTA web, si lo tiene. */
  contract: { clientProductId: string; status: string; billingInterval: string | null } | null;
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
          select: { id: true, status: true, subscription: { select: { billingInterval: true } } },
        })
      : null,
  ]);
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
      ? { clientProductId: contract.id, status: contract.status, billingInterval: contract.subscription?.billingInterval ?? null }
      : null,
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
