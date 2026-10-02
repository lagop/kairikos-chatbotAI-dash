import 'server-only';
import type Stripe from 'stripe';
import { prisma } from './prisma';
import { getStripe, isStripeConfigured } from './stripe';
import { ensureCustomerForTenant } from './stripe-billing';
import { resolveContractedInstance } from './client-product-access';
import { portalBaseUrl } from './portal-base-url';
import { logError } from './observability';
import { USAGE_PACKS, isUsagePackCode, type UsagePackCode } from './usage-pack-catalog';

// =============================================================================
// Plan de precios del 01/10/2026 — los packs de uso.
//
// Un pack es saldo de una sola vez para una contratación concreta: +2.000
// mensajes para UN chatbot (un cliente puede tener varios) o +100 negocios
// para su campaña de prospección. Se compra cuantas veces haga falta, así que
// no es una ClientProduct —el índice único parcial lo impediría— sino una fila
// de UsagePackPurchase.
//
// El saldo no caduca: se gasta cuando se acaba el cupo del mes (ver
// chatbot-usage.ts y prospecting.ts). El precio vive en el catálogo (una fila
// Product con kind 'pack', creada en Stripe desde el panel); lo que da cada
// pack, en usage-pack-catalog.ts.
//
// El abono lo hace el webhook (checkout.session.completed), nunca la vuelta
// del navegador: volver a la página de éxito no prueba que se haya cobrado.
// =============================================================================

export type UsagePackCheckoutError =
  | 'unknown_pack'
  | 'stripe_not_configured'
  | 'target_not_found'
  | 'pack_not_on_sale'
  | 'client_has_no_tenant'
  | 'stripe_customer_create_failed'
  | 'stripe_error';

export type UsagePackCheckoutResult = { ok: true; url: string } | { ok: false; error: UsagePackCheckoutError };

/** Adónde vuelve el cliente: a la pantalla desde la que lo compró. */
function returnPath(packCode: UsagePackCode, targetClientProductId: string): string {
  return USAGE_PACKS[packCode].appliesTo === 'chatbot'
    ? `/portal/canales?clientProductId=${encodeURIComponent(targetClientProductId)}`
    : '/portal/leads';
}

export async function createUsagePackCheckout(params: {
  clientId: string;
  packCode: string;
  /** La contratación que recibe el saldo. Obligatoria con varios chatbots;
   *  con uno solo se puede omitir. */
  targetClientProductId?: string | null;
}): Promise<UsagePackCheckoutResult> {
  if (!isUsagePackCode(params.packCode)) return { ok: false, error: 'unknown_pack' };
  const packCode = params.packCode;
  const pack = USAGE_PACKS[packCode];
  if (!(await isStripeConfigured())) return { ok: false, error: 'stripe_not_configured' };

  // El cliente solo puede cargar saldo a lo SUYO: la contratación se resuelve
  // contra su clientId, nunca se acepta tal cual de la petición.
  const target = await resolveContractedInstance(prisma, {
    clientId: params.clientId,
    productCode: pack.appliesTo,
    clientProductId: params.targetClientProductId ?? null,
  });
  if (!target) return { ok: false, error: 'target_not_found' };

  const product = await prisma.product.findFirst({
    where: { code: packCode, kind: 'pack', isActive: true },
    select: { id: true, setupFeeCents: true, currency: true, stripeSetupPriceId: true },
  });
  if (!product || !product.stripeSetupPriceId || product.setupFeeCents <= 0) {
    return { ok: false, error: 'pack_not_on_sale' };
  }

  const client = await prisma.chatbotClient.findUnique({ where: { id: params.clientId }, select: { tenantId: true } });
  if (!client?.tenantId) return { ok: false, error: 'client_has_no_tenant' };
  const customerId = await ensureCustomerForTenant(client.tenantId);
  if (!customerId) return { ok: false, error: 'stripe_customer_create_failed' };

  const purchase = await prisma.usagePackPurchase.create({
    data: {
      clientId: params.clientId,
      tenantId: client.tenantId,
      productId: product.id,
      packCode,
      targetClientProductId: target.clientProductId,
      units: pack.units,
      amountCents: product.setupFeeCents,
      currency: product.currency,
      status: 'pending',
    },
  });

  const back = `${portalBaseUrl()}${returnPath(packCode, target.clientProductId)}`;
  const sep = back.includes('?') ? '&' : '?';
  const metadata = {
    kairikos_usage_pack_purchase_id: purchase.id,
    kairikos_client_id: params.clientId,
    kairikos_tenant_id: client.tenantId,
    kairikos_pack_code: packCode,
  };

  try {
    const stripe = await getStripe();
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      line_items: [{ price: product.stripeSetupPriceId, quantity: 1 }],
      invoice_creation: { enabled: true, invoice_data: { metadata } },
      metadata,
      success_url: `${back}${sep}pack=ok`,
      cancel_url: `${back}${sep}pack=cancelado`,
    });
    if (!session.url) throw new Error('stripe_checkout_session_missing_url');
    await prisma.usagePackPurchase.update({
      where: { id: purchase.id },
      data: { stripeCheckoutSessionId: session.id },
    });
    return { ok: true, url: session.url };
  } catch (err) {
    logError('usage_packs.checkout_failed', err, { purchaseId: purchase.id, packCode });
    await prisma.usagePackPurchase
      .update({ where: { id: purchase.id }, data: { status: 'expired' } })
      .catch(() => {});
    return { ok: false, error: 'stripe_error' };
  }
}

/**
 * checkout.session.completed de un pack: suma el saldo a su contratación.
 *
 * Idempotente: el paso de 'pending' a 'credited' y el abono van en la misma
 * transacción, condicionados a que la compra siga 'pending'. Un webhook
 * repetido encuentra la compra ya abonada y no suma nada.
 *
 * Solo con payment_status 'paid'. Los packs se pagan con tarjeta en el acto;
 * un medio de pago diferido llegaría como 'unpaid' y no se abona hasta que
 * Stripe confirme (limitación conocida: hoy no se escucha
 * checkout.session.async_payment_succeeded, porque la cuenta solo cobra con
 * tarjeta).
 */
export async function creditUsagePackFromCheckout(session: Stripe.Checkout.Session): Promise<void> {
  const purchaseId = (session.metadata?.kairikos_usage_pack_purchase_id ?? null) as string | null;
  if (!purchaseId) return;
  if (session.payment_status !== 'paid') return;

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.usagePackPurchase.updateMany({
      where: { id: purchaseId, status: 'pending' },
      data: { status: 'credited', creditedAt: new Date(), stripeCheckoutSessionId: session.id },
    });
    if (claimed.count === 0) return;

    const purchase = await tx.usagePackPurchase.findUniqueOrThrow({ where: { id: purchaseId } });
    if (!isUsagePackCode(purchase.packCode)) {
      throw new Error(`unknown_pack_code:${purchase.packCode}`);
    }

    if (USAGE_PACKS[purchase.packCode].appliesTo === 'chatbot') {
      await tx.chatbotUsage.upsert({
        where: { clientProductId: purchase.targetClientProductId },
        create: {
          clientProductId: purchase.targetClientProductId,
          clientId: purchase.clientId,
          tenantId: purchase.tenantId,
          packMessagesRemaining: purchase.units,
        },
        update: {
          packMessagesRemaining: { increment: purchase.units },
          // Con saldo nuevo, el próximo tope vuelve a merecer aviso.
          capAlertedAt: null,
        },
      });
    } else {
      const updated = await tx.prospectingCampaign.updateMany({
        where: { clientProductId: purchase.targetClientProductId },
        data: { packLeadsRemaining: { increment: purchase.units }, alertedAt: null },
      });
      // La campaña nace al contratar prospección (ensureProspectingCampaign),
      // así que esto no debería pasar. Si pasa, mejor que el webhook falle y
      // Stripe lo reintente a que el cliente pague y el saldo no exista.
      if (updated.count === 0) {
        throw new Error(`prospecting_campaign_not_found:${purchase.targetClientProductId}`);
      }
    }
  });
}

/** checkout.session.expired de un pack: se abandonó el pago. */
export async function expireUsagePackFromCheckout(session: Stripe.Checkout.Session): Promise<void> {
  const purchaseId = (session.metadata?.kairikos_usage_pack_purchase_id ?? null) as string | null;
  if (!purchaseId) return;
  await prisma.usagePackPurchase.updateMany({
    where: { id: purchaseId, status: 'pending' },
    data: { status: 'expired' },
  });
}

/** Si el pack se puede comprar ahora mismo (existe en Stripe), y su precio.
 *  Para que las tarjetas no ofrezcan un botón que acabaría en error. */
export async function getUsagePackOffer(
  packCode: UsagePackCode,
): Promise<{ priceCents: number; currency: string; units: number } | null> {
  const product = await prisma.product.findFirst({
    where: { code: packCode, kind: 'pack', isActive: true },
    select: { setupFeeCents: true, currency: true, stripeSetupPriceId: true },
  });
  if (!product?.stripeSetupPriceId || product.setupFeeCents <= 0) return null;
  return { priceCents: product.setupFeeCents, currency: product.currency, units: USAGE_PACKS[packCode].units };
}
