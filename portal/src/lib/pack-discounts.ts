import 'server-only';
import type Stripe from 'stripe';
import type { PrismaClient } from '@prisma/client';
import { getStripe } from './stripe';
import { resolveActiveStripeSecret } from './stripe-credentials';
import { logError } from './observability';
import {
  COMBO_PACKS,
  DISCOUNTED_COMPONENT,
  isComboPackCode,
  packCouponAmountCents,
  qualifyingPack,
  type ComboPackCode,
} from './combo-packs';

// =============================================================================
// Plan de precios del 01/10/2026 — aplicar en Stripe el descuento de los packs
// de productos (lib/combo-packs.ts tiene la regla).
//
// Dos piezas:
//
// 1. Los cupones (createPackCoupons): uno por pack y por intervalo, de duración
//    'forever' y limitados al producto de Reseñas Basic (applies_to), para que
//    no puedan rebajar ninguna otra cosa aunque acabaran en otra suscripción.
//    Los crea el operador desde el panel, con segundo factor.
//
// 2. El barrido (syncPackDiscounts): para cada suscripción viva de Reseñas
//    Basic, mira qué pack corresponde AHORA al cliente y deja en Stripe ese
//    cupón, o ninguno. Idempotente: compara con Subscription.packCode y solo
//    llama a Stripe si cambia. Lo llama un cron (sync-pack-discounts), y la
//    lógica de «¿toca?» está aquí, no en la cadencia.
//
// Al quitar o cambiar el pack se conservan los demás descuentos de la
// suscripción: solo se tocan los cupones que son de packs.
//
// Stripe aplica un descuento nuevo a las facturas SIGUIENTES, no a la que ya
// está emitida: un cliente que completa el pack a mitad de mes lo nota en la
// próxima factura. Aceptado: no hay prorrateo en este catálogo.
// =============================================================================

export interface PackCouponActor {
  operatorId: string;
  operatorEmail: string | null;
}

export type CreatePackCouponsResult =
  | { ok: true; created: number; existing: number }
  | { ok: false; error: 'reviews_basic_not_bootstrapped' | 'stripe_error' };

/** Crea en Stripe los cupones que falten. Repetirlo no duplica nada. */
export async function createPackCoupons(prisma: PrismaClient, actor: PackCouponActor): Promise<CreatePackCouponsResult> {
  const reviewsBasic = await prisma.product.findFirst({
    where: { code: DISCOUNTED_COMPONENT.code, tier: DISCOUNTED_COMPONENT.tier },
    select: { id: true, stripeProductId: true },
  });
  if (!reviewsBasic?.stripeProductId) return { ok: false, error: 'reviews_basic_not_bootstrapped' };

  const existing = await prisma.packCoupon.findMany({ select: { packCode: true, interval: true } });
  const have = new Set(existing.map((c) => `${c.packCode}:${c.interval}`));
  const resolved = await resolveActiveStripeSecret();
  const stripe = await getStripe();

  let created = 0;
  try {
    for (const pack of Object.keys(COMBO_PACKS) as ComboPackCode[]) {
      for (const interval of ['month', 'year'] as const) {
        if (have.has(`${pack}:${interval}`)) continue;
        const amountOffCents = packCouponAmountCents(pack, interval);
        const coupon = await stripe.coupons.create({
          name: interval === 'year' ? `${COMBO_PACKS[pack].label} (anual)` : COMBO_PACKS[pack].label,
          amount_off: amountOffCents,
          currency: 'eur',
          duration: 'forever',
          applies_to: { products: [reviewsBasic.stripeProductId] },
          metadata: { kairikos_pack: pack, kairikos_interval: interval },
        });
        await prisma.packCoupon.create({
          data: { packCode: pack, interval, stripeCouponId: coupon.id, amountOffCents, stripeMode: resolved?.mode ?? null },
        });
        await prisma.stripeCatalogAudit.create({
          data: {
            productId: reviewsBasic.id,
            action: 'pack_coupon_created',
            after: { packCode: pack, interval, stripeCouponId: coupon.id, amountOffCents },
            actorOperatorId: actor.operatorId,
            actorEmail: actor.operatorEmail,
          },
        });
        created += 1;
      }
    }
  } catch (err) {
    logError('pack_discounts.create_coupons_failed', err, { created });
    return { ok: false, error: 'stripe_error' };
  }
  return { ok: true, created, existing: have.size };
}

export interface PackSyncResult {
  checked: number;
  applied: number;
  removed: number;
  skippedNoCoupon: number;
  failed: number;
}

const LIVE_SUBSCRIPTION = ['active', 'trialing', 'past_due'];

/** Los descuentos que hay que dejar en la suscripción: los que no son de
 *  packs, tal cual, más el cupón del pack si lo hay. Pura. */
export function nextDiscounts(
  current: ReadonlyArray<{ id: string; couponId: string | null }>,
  packCouponIds: ReadonlySet<string>,
  desiredCouponId: string | null,
): Array<{ discount: string } | { coupon: string }> {
  const kept = current.filter((d) => !d.couponId || !packCouponIds.has(d.couponId)).map((d) => ({ discount: d.id }));
  return desiredCouponId ? [...kept, { coupon: desiredCouponId }] : kept;
}

export async function syncPackDiscounts(prisma: PrismaClient, now: Date = new Date()): Promise<PackSyncResult> {
  const result: PackSyncResult = { checked: 0, applied: 0, removed: 0, skippedNoCoupon: 0, failed: 0 };

  const coupons = await prisma.packCoupon.findMany({ select: { packCode: true, interval: true, stripeCouponId: true } });
  const couponFor = (pack: string, interval: string) =>
    coupons.find((c) => c.packCode === pack && c.interval === interval)?.stripeCouponId ?? null;
  const packCouponIds = new Set(coupons.map((c) => c.stripeCouponId));

  // Cada suscripción viva de Reseñas Basic: es la que lleva el descuento.
  const carriers = await prisma.clientProduct.findMany({
    where: {
      status: 'active',
      product: { code: DISCOUNTED_COMPONENT.code, tier: DISCOUNTED_COMPONENT.tier },
      subscription: { status: { in: LIVE_SUBSCRIPTION } },
    },
    select: {
      clientId: true,
      subscription: { select: { id: true, stripeId: true, billingInterval: true, packCode: true } },
    },
  });

  for (const carrier of carriers) {
    const sub = carrier.subscription;
    if (!sub) continue;
    result.checked += 1;
    try {
      const active = await prisma.clientProduct.findMany({
        where: { clientId: carrier.clientId, status: 'active' },
        select: { product: { select: { code: true, tier: true } } },
      });
      const desired = qualifyingPack(active.map((a) => a.product));
      const current = sub.packCode && isComboPackCode(sub.packCode) ? sub.packCode : null;
      if (desired === current) continue;

      const interval = sub.billingInterval === 'year' ? 'year' : 'month';
      const desiredCouponId = desired ? couponFor(desired, interval) : null;
      if (desired && !desiredCouponId) {
        // El pack corresponde pero el operador aún no creó sus cupones: no se
        // toca nada (tampoco se quita el anterior) hasta que existan.
        result.skippedNoCoupon += 1;
        continue;
      }

      const stripe = await getStripe();
      const live = await stripe.subscriptions.retrieve(sub.stripeId, { expand: ['discounts'] });
      const currentDiscounts = (live.discounts ?? []).map((d) => {
        const disc = d as Stripe.Discount | string;
        return typeof disc === 'string'
          ? { id: disc, couponId: null }
          : { id: disc.id, couponId: disc.coupon?.id ?? null };
      });
      await stripe.subscriptions.update(sub.stripeId, {
        discounts: nextDiscounts(currentDiscounts, packCouponIds, desiredCouponId),
      });
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { packCode: desired, packAppliedAt: desired ? now : null },
      });
      if (desired) result.applied += 1;
      else result.removed += 1;
    } catch (err) {
      result.failed += 1;
      logError('pack_discounts.sync_failed', err, { clientId: carrier.clientId, subscriptionId: sub.id });
    }
  }
  return result;
}

/** Qué cupones existen ya, para el panel. */
export async function listPackCoupons(prisma: PrismaClient) {
  return prisma.packCoupon.findMany({
    select: { packCode: true, interval: true, stripeCouponId: true, amountOffCents: true, stripeMode: true },
    orderBy: [{ packCode: 'asc' }, { interval: 'asc' }],
  });
}
