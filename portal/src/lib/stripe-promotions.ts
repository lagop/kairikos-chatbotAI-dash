import 'server-only';
import type Stripe from 'stripe';
import { prisma } from './prisma';
import { getStripe } from './stripe';
import type { CatalogActor } from './stripe-catalog';
import { logError } from './observability';

// =============================================================================
// 2026-09-16 — códigos promocionales que anulan el alta de un producto.
//
// POR QUÉ: la competencia directa (Landbot, NiceJob, GoHighLevel…) vende sin
// cuota de alta, y la decisión fue lanzar Chatbot Starter —y lo que haga
// falta— sin alta como OFERTA, retirable, en vez de bajar el precio del
// catálogo a 0. Cambiar el precio es permanente hasta que alguien lo vuelve
// a cambiar; un código se desactiva con un clic y el precio de catálogo
// sigue diciendo lo que vale el alta.
//
// CÓMO FUNCIONA EN STRIPE, y por qué así:
//
//   · Un Coupon con amount_off = el alta del producto, duration 'once', y
//     applies_to = el Stripe Product del tier. La primera factura de la
//     suscripción lleva cuota + alta; el cupón resta exactamente el alta y
//     el cliente paga solo la cuota. Del segundo mes en adelante, nada.
//   · applies_to es lo que impide que el código sirva para otro producto:
//     sin él, un cupón de 399 € anularía también la primera factura de
//     cualquier otro tier. La cuota y el alta de un tier cuelgan del mismo
//     Stripe Product (stripe-catalog.ts crea las dos Price sobre él), así
//     que el cupón las alcanza a las dos, pero su importe es el del alta.
//   · Un Promotion Code encima, con el texto que teclea el cliente. Un
//     cupón por código, para que desactivar uno no toque a los demás.
//
// EL IMPORTE QUEDA FIJADO AL CREAR. Si luego se cambia el alta del tier con
// repriceStripeTier, el código sigue restando el importe antiguo. La lista
// lo marca como desfasado (`stale`) para que el operador lo sustituya.
//
// Los códigos se reconocen por metadata.kairikos_kind; el resto de códigos
// que existan en la cuenta de Stripe (creados a mano) no se listan ni se
// pueden desactivar desde aquí.
// =============================================================================

export const SETUP_FEE_WAIVER_KIND = 'setup_fee_waiver';

/** Lo que Stripe acepta en `code`, restringido a lo que se puede dictar
 *  por teléfono sin equivocarse: letras, números, guion y guion bajo. */
const CODE_RE = /^[A-Z0-9_-]{3,40}$/;

export function normalisePromotionCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

/** Stripe limita el nombre del cupón a 40 caracteres. */
export function couponName(productName: string): string {
  const prefix = 'Sin alta · ';
  const room = 40 - prefix.length;
  const name = productName.length > room ? `${productName.slice(0, room - 1)}…` : productName;
  return `${prefix}${name}`;
}

export interface SetupFeeWaiverCode {
  id: string;
  code: string;
  active: boolean;
  productId: string | null;
  productName: string | null;
  amountOffCents: number;
  currentSetupFeeCents: number | null;
  /** El alta del tier ya no coincide con lo que resta el código. */
  stale: boolean;
  timesRedeemed: number;
  maxRedemptions: number | null;
  expiresAt: string | null;
  createdAt: string;
}

export type CreateWaiverError =
  | 'product_not_found'
  | 'not_bootstrapped'
  | 'no_setup_fee'
  | 'invalid_code'
  | 'invalid_expiry'
  | 'code_already_exists'
  | 'stripe_error';

export type CreateWaiverResult =
  | { ok: true; promotionCode: SetupFeeWaiverCode }
  | { ok: false; error: CreateWaiverError; detail?: string };

export async function createSetupFeeWaiverCode(
  input: { productId: string; code: string; expiresAt?: Date | null; maxRedemptions?: number | null },
  actor: CatalogActor,
  now: Date = new Date(),
): Promise<CreateWaiverResult> {
  const code = normalisePromotionCode(input.code);
  if (!code) return { ok: false, error: 'invalid_code' };
  if (input.expiresAt && input.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, error: 'invalid_expiry' };
  }

  const product = await prisma.product.findUnique({ where: { id: input.productId } });
  if (!product) return { ok: false, error: 'product_not_found' };
  if (!product.stripeProductId) return { ok: false, error: 'not_bootstrapped' };
  if (product.setupFeeCents <= 0 || !product.stripeSetupPriceId) return { ok: false, error: 'no_setup_fee' };

  const stripe = await getStripe();
  const metadata = {
    kairikos_kind: SETUP_FEE_WAIVER_KIND,
    kairikos_product_id: product.id,
    kairikos_setup_fee_cents: String(product.setupFeeCents),
  };

  let coupon: Stripe.Coupon;
  try {
    coupon = await stripe.coupons.create({
      name: couponName(product.name),
      amount_off: product.setupFeeCents,
      currency: product.currency.toLowerCase(),
      duration: 'once',
      applies_to: { products: [product.stripeProductId] },
      metadata,
    });
  } catch (err) {
    logError('stripe_promotions.coupon_create_failed', err, { productId: product.id });
    return { ok: false, error: 'stripe_error', detail: err instanceof Error ? err.message : undefined };
  }

  let promotion: Stripe.PromotionCode;
  try {
    promotion = await stripe.promotionCodes.create({
      coupon: coupon.id,
      code,
      ...(input.expiresAt ? { expires_at: Math.floor(input.expiresAt.getTime() / 1000) } : {}),
      ...(input.maxRedemptions ? { max_redemptions: input.maxRedemptions } : {}),
      metadata,
    });
  } catch (err) {
    // Sin código, el cupón no lo puede usar nadie: se borra para no dejar
    // basura en la cuenta. Si el borrado también falla, es cosmético.
    await stripe.coupons.del(coupon.id).catch(() => null);
    const message = err instanceof Error ? err.message : '';
    // Stripe responde 400 con este texto cuando el código ya existe activo.
    if (/already exists/i.test(message)) return { ok: false, error: 'code_already_exists' };
    logError('stripe_promotions.promotion_code_create_failed', err, { productId: product.id });
    return { ok: false, error: 'stripe_error', detail: message || undefined };
  }

  await prisma.stripeCatalogAudit
    .create({
      data: {
        productId: product.id,
        action: 'promotion_code_created',
        after: {
          promotionCodeId: promotion.id,
          couponId: coupon.id,
          code,
          amountOffCents: product.setupFeeCents,
          expiresAt: input.expiresAt?.toISOString() ?? null,
          maxRedemptions: input.maxRedemptions ?? null,
        },
        actorOperatorId: actor.operatorId,
        actorEmail: actor.operatorEmail,
      },
    })
    .catch((err) => logError('stripe_promotions.audit_failed', err, { promotionCodeId: promotion.id }, 'warn'));

  return {
    ok: true,
    promotionCode: toView(promotion, coupon, new Map([[product.id, product]])),
  };
}

function toView(
  promotion: Stripe.PromotionCode,
  coupon: Stripe.Coupon,
  products: ReadonlyMap<string, { name: string; setupFeeCents: number }>,
): SetupFeeWaiverCode {
  const productId = promotion.metadata?.kairikos_product_id ?? coupon.metadata?.kairikos_product_id ?? null;
  const product = productId ? products.get(productId) : undefined;
  const amountOffCents = coupon.amount_off ?? 0;
  return {
    id: promotion.id,
    code: promotion.code,
    active: promotion.active,
    productId,
    productName: product?.name ?? null,
    amountOffCents,
    currentSetupFeeCents: product?.setupFeeCents ?? null,
    stale: product ? product.setupFeeCents !== amountOffCents : false,
    timesRedeemed: promotion.times_redeemed,
    maxRedemptions: promotion.max_redemptions ?? null,
    expiresAt: promotion.expires_at ? new Date(promotion.expires_at * 1000).toISOString() : null,
    createdAt: new Date(promotion.created * 1000).toISOString(),
  };
}

function isWaiver(promotion: Stripe.PromotionCode): boolean {
  return promotion.metadata?.kairikos_kind === SETUP_FEE_WAIVER_KIND;
}

/** Los códigos creados desde aquí, activos primero. Nunca lanza. */
export async function listSetupFeeWaiverCodes(): Promise<
  { ok: true; codes: SetupFeeWaiverCode[] } | { ok: false; error: 'stripe_error' }
> {
  try {
    const stripe = await getStripe();
    const listed = await stripe.promotionCodes.list({ limit: 100 });
    const waivers = listed.data.filter(isWaiver);

    const productIds = [
      ...new Set(waivers.map((p) => p.metadata?.kairikos_product_id).filter((id): id is string => Boolean(id))),
    ];
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true, setupFeeCents: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));

    const codes = waivers
      .map((p) => toView(p, p.coupon, byId))
      .sort((a, b) => Number(b.active) - Number(a.active) || b.createdAt.localeCompare(a.createdAt));
    return { ok: true, codes };
  } catch (err) {
    logError('stripe_promotions.list_failed', err, {}, 'warn');
    return { ok: false, error: 'stripe_error' };
  }
}

export type DeactivateWaiverResult =
  | { ok: true }
  | { ok: false; error: 'not_found' | 'stripe_error' };

export async function deactivateSetupFeeWaiverCode(
  promotionCodeId: string,
  actor: CatalogActor,
): Promise<DeactivateWaiverResult> {
  const stripe = await getStripe();
  let promotion: Stripe.PromotionCode;
  try {
    promotion = await stripe.promotionCodes.retrieve(promotionCodeId);
  } catch {
    return { ok: false, error: 'not_found' };
  }
  // Solo los que se crearon desde el portal: un código hecho a mano en el
  // Dashboard de Stripe es de quien lo hizo.
  if (!isWaiver(promotion)) return { ok: false, error: 'not_found' };

  if (promotion.active) {
    try {
      await stripe.promotionCodes.update(promotionCodeId, { active: false });
    } catch (err) {
      logError('stripe_promotions.deactivate_failed', err, { promotionCodeId });
      return { ok: false, error: 'stripe_error' };
    }
  }

  await prisma.stripeCatalogAudit
    .create({
      data: {
        productId: promotion.metadata?.kairikos_product_id ?? null,
        action: 'promotion_code_deactivated',
        before: { promotionCodeId, code: promotion.code, active: promotion.active },
        after: { promotionCodeId, code: promotion.code, active: false },
        actorOperatorId: actor.operatorId,
        actorEmail: actor.operatorEmail,
      },
    })
    .catch((err) => logError('stripe_promotions.audit_failed', err, { promotionCodeId }, 'warn'));

  return { ok: true };
}
