import 'server-only';
import type { Prisma } from '@prisma/client';
import { MAX_TRIAL_MONTHS, WEB_CARE_PRODUCT_CODE } from './custom-care-rules';

export { firstChargeDate, normalizeMonthlyCents, MAX_TRIAL_MONTHS } from './custom-care-rules';

// =============================================================================
// Mantenimiento a medida (11/11/2026).
//
// El Cuidado de la web cuesta 29 €/mes en el catálogo, pero una web con
// integraciones o un área privada cuesta más de mantener, y una web premium
// lleva sus primeros 12 meses incluidos. Esto deja ofrecer el mismo producto
// ('web_care') con un precio pactado y un número de meses sin cobrar.
//
// UNA OFERTA ES UNA FILA DE ClientProduct EN 'pending_payment' con
// customPriceCents. No se cobra ni se activa nada al crearla: el cliente la
// ve en la página de su web y la activa guardando su tarjeta en Stripe
// (createCustomCareCheckout, lib/web-care.ts). Proponer y persistir son dos
// pasos, y el segundo es del cliente. Hasta entonces el operador puede
// retirarla o sustituirla por otra.
//
// Nace por dos caminos:
//   - un presupuesto a medida con cuota (WebQuote.monthlyCents), al pagarse
//     la web (activateClientProductFromWebQuotePayment);
//   - el operador, para una web que ya existe («solo mantenimiento»).
//
// Va por web, como el Cuidado de siempre: la fila lleva el clientSiteId de su
// web desde que nace, y una web tiene como mucho una oferta pendiente.
//
// No hay ofertas de 0 €: «sin mantenimiento» es no tener oferta. Stripe
// aceptaría una suscripción de 0 € y mandaría una factura vacía cada mes.
// =============================================================================

type Db = Prisma.TransactionClient;

export type CreateCustomCareOfferResult =
  | { ok: true; clientProductId: string }
  | { ok: false; error: 'care_product_missing' | 'already_contracted' | 'invalid_price' | 'invalid_trial' };

/**
 * Crea la oferta de mantenimiento a medida de una web. Si esa web ya tenía
 * otra pendiente, la retira: la nueva la sustituye. Si ya tiene el Cuidado
 * contratado, no hace nada (subir o bajar una cuota que ya se cobra es otra
 * operación, en Stripe).
 */
export async function createCustomCareOffer(
  db: Db,
  input: {
    clientId: string;
    tenantId: string | null;
    clientSiteId: string;
    priceCents: number;
    trialMonths: number;
    actorId: string;
  },
): Promise<CreateCustomCareOfferResult> {
  if (!Number.isInteger(input.priceCents) || input.priceCents <= 0) return { ok: false, error: 'invalid_price' };
  if (!Number.isInteger(input.trialMonths) || input.trialMonths < 0 || input.trialMonths > MAX_TRIAL_MONTHS) {
    return { ok: false, error: 'invalid_trial' };
  }

  const product = await db.product.findFirst({
    where: { code: WEB_CARE_PRODUCT_CODE, kind: 'addon', isActive: true },
    select: { id: true },
  });
  if (!product) return { ok: false, error: 'care_product_missing' };

  const contracted = await db.clientProduct.findFirst({
    where: { clientId: input.clientId, clientSiteId: input.clientSiteId, productId: product.id, status: { in: ['active', 'paused'] } },
    select: { id: true },
  });
  if (contracted) return { ok: false, error: 'already_contracted' };

  const previous = await db.clientProduct.findMany({
    where: {
      clientId: input.clientId,
      clientSiteId: input.clientSiteId,
      productId: product.id,
      status: 'pending_payment',
    },
    select: { id: true },
  });
  for (const row of previous) {
    await db.clientProduct.update({ where: { id: row.id }, data: { status: 'cancelled', cancelledAt: new Date() } });
    await db.clientProductAudit.create({
      data: {
        clientProductId: row.id,
        clientId: input.clientId,
        productId: product.id,
        tenantId: input.tenantId,
        action: 'custom_care_replaced',
        statusBefore: 'pending_payment',
        statusAfter: 'cancelled',
        actorId: input.actorId,
      },
    });
  }

  const created = await db.clientProduct.create({
    data: {
      clientId: input.clientId,
      productId: product.id,
      tenantId: input.tenantId,
      clientSiteId: input.clientSiteId,
      status: 'pending_payment',
      customPriceCents: input.priceCents,
      customTrialMonths: input.trialMonths,
      createdBy: input.actorId,
    },
  });
  await db.clientProductAudit.create({
    data: {
      clientProductId: created.id,
      clientId: input.clientId,
      productId: product.id,
      tenantId: input.tenantId,
      action: 'custom_care_offered',
      statusBefore: null,
      statusAfter: 'pending_payment',
      actorId: input.actorId,
    },
  });
  return { ok: true, clientProductId: created.id };
}

/** Retira una oferta que el cliente aún no ha activado. */
export async function withdrawCustomCareOffer(
  db: Db,
  input: { clientId: string; clientProductId: string; actorId: string },
): Promise<boolean> {
  const row = await db.clientProduct.findFirst({
    where: {
      id: input.clientProductId,
      clientId: input.clientId,
      status: 'pending_payment',
      customPriceCents: { not: null },
      product: { code: WEB_CARE_PRODUCT_CODE },
    },
    select: { id: true, productId: true, tenantId: true },
  });
  if (!row) return false;
  const claimed = await db.clientProduct.updateMany({
    where: { id: row.id, status: 'pending_payment' },
    data: { status: 'cancelled', cancelledAt: new Date() },
  });
  if (claimed.count === 0) return false;
  await db.clientProductAudit.create({
    data: {
      clientProductId: row.id,
      clientId: input.clientId,
      productId: row.productId,
      tenantId: row.tenantId,
      action: 'custom_care_withdrawn',
      statusBefore: 'pending_payment',
      statusAfter: 'cancelled',
      actorId: input.actorId,
    },
  });
  return true;
}

export interface CustomCareOffer {
  clientProductId: string;
  priceCents: number;
  trialMonths: number;
  currency: string;
}

/** La oferta pendiente de una web, si la hay. */
export async function findCustomCareOffer(
  db: Db,
  clientId: string,
  clientSiteId: string,
): Promise<CustomCareOffer | null> {
  const row = await db.clientProduct.findFirst({
    where: {
      clientId,
      clientSiteId,
      status: 'pending_payment',
      customPriceCents: { not: null },
      product: { code: WEB_CARE_PRODUCT_CODE },
    },
    orderBy: { subscribedAt: 'desc' },
    select: { id: true, customPriceCents: true, customTrialMonths: true, product: { select: { currency: true } } },
  });
  if (!row || row.customPriceCents == null) return null;
  return {
    clientProductId: row.id,
    priceCents: row.customPriceCents,
    trialMonths: row.customTrialMonths ?? 0,
    currency: row.product.currency,
  };
}
