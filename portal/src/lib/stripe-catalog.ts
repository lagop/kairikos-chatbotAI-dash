import 'server-only';
import type { Product } from '@prisma/client';
import { prisma } from './prisma';
import { getStripe } from './stripe';
import { resolveActiveStripeSecret } from './stripe-credentials';
import { logError } from './observability';

export interface CatalogActor {
  operatorId: string;
  operatorEmail: string | null;
}

export type CatalogMutationError =
  | { kind: 'already_bootstrapped' }
  | { kind: 'not_bootstrapped_yet' }
  | { kind: 'concurrent_modification' }
  | {
      kind: 'partial_failure';
      stripeProductId: string;
      stripeRecurringPriceId: string | null;
      stripeSetupPriceId: string | null;
    };

export type CatalogMutationResult =
  | { ok: true; product: Product }
  | { ok: false; error: CatalogMutationError };

function auditSnapshot(product: Product, mode: string | null) {
  return {
    stripeProductId: product.stripeProductId,
    stripeRecurringPriceId: product.stripeRecurringPriceId,
    stripeSetupPriceId: product.stripeSetupPriceId,
    stripePriceMode: mode,
    priceCents: product.priceCents,
    setupFeeCents: product.setupFeeCents,
  };
}

/**
 * Creates the Stripe Product + Price(s) for a tier that has never been
 * provisioned on Stripe (Product.stripeProductId is NULL — the
 * placeholder-id state every tier starts in). Idempotent against
 * double-submission via the already_bootstrapped check, NOT against a
 * partial failure — see the partial_failure branch below.
 */
export async function bootstrapStripeProductForTier(
  productId: string,
  actor: CatalogActor,
): Promise<CatalogMutationResult> {
  const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
  if (product.stripeProductId) {
    return { ok: false, error: { kind: 'already_bootstrapped' } };
  }

  const resolved = await resolveActiveStripeSecret();
  const stripe = await getStripe();

  const stripeProduct = await stripe.products.create({
    name: product.name,
    metadata: { kairikos_product_id: product.id, code: product.code, tier: product.tier },
  });

  let recurringPriceId: string | null = null;
  if (product.priceCents > 0) {
    const recurringPrice = await stripe.prices.create({
      product: stripeProduct.id,
      currency: product.currency.toLowerCase(),
      unit_amount: product.priceCents,
      recurring: { interval: 'month' },
      metadata: { kairikos_product_id: product.id },
    });
    recurringPriceId = recurringPrice.id;
  }

  let setupPriceId: string | null = null;
  if (product.setupFeeCents > 0) {
    const setupPrice = await stripe.prices.create({
      product: stripeProduct.id,
      currency: product.currency.toLowerCase(),
      unit_amount: product.setupFeeCents,
      metadata: { kairikos_product_id: product.id },
    });
    setupPriceId = setupPrice.id;
  }

  try {
    const before = auditSnapshot(product, null);
    const [updated] = await prisma.$transaction([
      prisma.product.update({
        where: { id: product.id },
        data: {
          stripeProductId: stripeProduct.id,
          stripeRecurringPriceId: recurringPriceId,
          stripeSetupPriceId: setupPriceId,
          stripePriceMode: resolved?.mode ?? null,
        },
      }),
      prisma.stripeCatalogAudit.create({
        data: {
          productId: product.id,
          action: 'price_bootstrap_created',
          before,
          after: {
            stripeProductId: stripeProduct.id,
            stripeRecurringPriceId: recurringPriceId,
            stripeSetupPriceId: setupPriceId,
            stripePriceMode: resolved?.mode ?? null,
            priceCents: product.priceCents,
            setupFeeCents: product.setupFeeCents,
          },
          actorOperatorId: actor.operatorId,
          actorEmail: actor.operatorEmail,
        },
      }),
    ]);
    return { ok: true, product: updated };
  } catch (err) {
    // Stripe objects were created successfully but the local write
    // failed — do NOT retry the Stripe calls (would create a duplicate
    // Product). Surface the ids so the caller can offer a reconcile
    // action that only writes to Prisma.
    logError('stripe-catalog.bootstrap_partial_failure', err, {
      productId: product.id,
      stripeProductId: stripeProduct.id,
      stripeRecurringPriceId: recurringPriceId,
      stripeSetupPriceId: setupPriceId,
    });
    return {
      ok: false,
      error: {
        kind: 'partial_failure',
        stripeProductId: stripeProduct.id,
        stripeRecurringPriceId: recurringPriceId,
        stripeSetupPriceId: setupPriceId,
      },
    };
  }
}

export interface DraftPricingInput {
  productId: string;
  newPriceCents: number;
  newSetupFeeCents: number;
  /** Optimistic-concurrency guard — must match the row's CURRENT values. */
  expectedPriceCents: number;
  expectedSetupFeeCents: number;
}

/**
 * Sets the price a tier will bootstrap WITH — before it has ever touched
 * Stripe. Writes straight to the Product row; there is no Stripe object
 * yet to keep in sync, which is what makes this safe to call with no
 * Stripe credential configured at all.
 *
 * Once bootstrapStripeProductForTier runs, it reads priceCents/
 * setupFeeCents off this same row — so a price set here is exactly what
 * gets bootstrapped, with no separate 'launch price' concept to keep in
 * sync. After bootstrap, this function refuses (already_bootstrapped):
 * repriceStripeTier is the only path from there, because changing a
 * live tier's price has to create new immutable Stripe Price objects,
 * not just edit a number.
 */
export async function updateDraftPricing(
  input: DraftPricingInput,
  actor: CatalogActor,
): Promise<CatalogMutationResult> {
  const product = await prisma.product.findUniqueOrThrow({ where: { id: input.productId } });
  if (product.stripeProductId) {
    return { ok: false, error: { kind: 'already_bootstrapped' } };
  }
  if (
    product.priceCents !== input.expectedPriceCents ||
    product.setupFeeCents !== input.expectedSetupFeeCents
  ) {
    return { ok: false, error: { kind: 'concurrent_modification' } };
  }

  const before = auditSnapshot(product, null);
  const [updated] = await prisma.$transaction([
    prisma.product.update({
      where: { id: product.id },
      data: { priceCents: input.newPriceCents, setupFeeCents: input.newSetupFeeCents },
    }),
    prisma.stripeCatalogAudit.create({
      data: {
        productId: product.id,
        action: 'draft_price_changed',
        before,
        after: { priceCents: input.newPriceCents, setupFeeCents: input.newSetupFeeCents },
        actorOperatorId: actor.operatorId,
        actorEmail: actor.operatorEmail,
      },
    }),
  ]);
  return { ok: true, product: updated };
}
export interface RepriceInput {
  productId: string;
  newPriceCents: number;
  /** null = leave the setup fee untouched. */
  newSetupFeeCents: number | null;
  /** Optimistic-concurrency guard — must match the row's CURRENT values. */
  expectedPriceCents: number;
  expectedSetupFeeCents: number;
}

/**
 * Changes a bootstrapped tier's price. Stripe Prices are immutable, so
 * this creates new Price object(s) under the tier's existing Stripe
 * Product and repoints the local row at them. Already-active
 * subscribers keep their current Stripe subscription price — Stripe
 * does this by default, and this function never calls
 * stripe.subscriptions.update, by design (see the plan's confirmed
 * business decision: no migration/proration in this version).
 */
export async function repriceStripeTier(
  input: RepriceInput,
  actor: CatalogActor,
): Promise<CatalogMutationResult> {
  const product = await prisma.product.findUniqueOrThrow({ where: { id: input.productId } });
  if (!product.stripeProductId) {
    return { ok: false, error: { kind: 'not_bootstrapped_yet' } };
  }
  if (
    product.priceCents !== input.expectedPriceCents ||
    product.setupFeeCents !== input.expectedSetupFeeCents
  ) {
    return { ok: false, error: { kind: 'concurrent_modification' } };
  }

  const resolved = await resolveActiveStripeSecret();
  const stripe = await getStripe();

  const newRecurringPrice = await stripe.prices.create({
    product: product.stripeProductId,
    currency: product.currency.toLowerCase(),
    unit_amount: input.newPriceCents,
    recurring: { interval: 'month' },
    metadata: { kairikos_product_id: product.id },
  });

  const setupFeeChanging = input.newSetupFeeCents !== null && input.newSetupFeeCents !== product.setupFeeCents;
  let newSetupPriceId: string | null = product.stripeSetupPriceId;
  let nextSetupFeeCents = product.setupFeeCents;
  if (input.newSetupFeeCents !== null) {
    nextSetupFeeCents = input.newSetupFeeCents;
    if (input.newSetupFeeCents === 0) {
      newSetupPriceId = null;
    } else if (setupFeeChanging || !product.stripeSetupPriceId) {
      const newSetupPrice = await stripe.prices.create({
        product: product.stripeProductId,
        currency: product.currency.toLowerCase(),
        unit_amount: input.newSetupFeeCents,
        metadata: { kairikos_product_id: product.id },
      });
      newSetupPriceId = newSetupPrice.id;
    }
  }

  // Best-effort archive of the superseded price(s) — a failure here is
  // cosmetic (the old Price stays `active: true` in Stripe but nothing
  // references it anymore locally) and must never block the reprice
  // itself from completing.
  const oldRecurringPriceId = product.stripeRecurringPriceId;
  const oldSetupPriceId = setupFeeChanging || (input.newSetupFeeCents === 0 && product.stripeSetupPriceId)
    ? product.stripeSetupPriceId
    : null;
  for (const oldId of [oldRecurringPriceId, oldSetupPriceId]) {
    if (!oldId) continue;
    await stripe.prices.update(oldId, { active: false }).catch(async (err) => {
      logError('stripe-catalog.price_archive_failed', err, { productId: product.id, stripePriceId: oldId });
      await prisma.stripeCatalogAudit
        .create({
          data: {
            productId: product.id,
            action: 'price_archive_failed',
            after: { stripePriceId: oldId },
            actorOperatorId: actor.operatorId,
            actorEmail: actor.operatorEmail,
          },
        })
        .catch(() => {});
    });
  }

  try {
    const before = auditSnapshot(product, product.stripePriceMode);
    const updateResult = await prisma.product.updateMany({
      where: { id: product.id, priceCents: input.expectedPriceCents, setupFeeCents: input.expectedSetupFeeCents },
      data: {
        priceCents: input.newPriceCents,
        setupFeeCents: nextSetupFeeCents,
        stripeRecurringPriceId: newRecurringPrice.id,
        stripeSetupPriceId: newSetupPriceId,
        stripePriceMode: resolved?.mode ?? product.stripePriceMode,
      },
    });
    if (updateResult.count === 0) {
      // A concurrent writer changed the row between our read above and
      // this write — the new Stripe Price objects already exist, so
      // this is the same "orphaned Stripe objects" situation as a
      // partial_failure, not a plain concurrent_modification (which
      // implies nothing was created yet).
      throw new Error('concurrent_modification_after_stripe_write');
    }
    await prisma.stripeCatalogAudit.create({
      data: {
        productId: product.id,
        action: 'price_repriced',
        before,
        after: {
          stripeProductId: product.stripeProductId,
          stripeRecurringPriceId: newRecurringPrice.id,
          stripeSetupPriceId: newSetupPriceId,
          stripePriceMode: resolved?.mode ?? product.stripePriceMode,
          priceCents: input.newPriceCents,
          setupFeeCents: nextSetupFeeCents,
        },
        actorOperatorId: actor.operatorId,
        actorEmail: actor.operatorEmail,
      },
    });
    const updated = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    return { ok: true, product: updated };
  } catch (err) {
    logError('stripe-catalog.reprice_partial_failure', err, {
      productId: product.id,
      stripeProductId: product.stripeProductId,
      stripeRecurringPriceId: newRecurringPrice.id,
      stripeSetupPriceId: newSetupPriceId,
    });
    return {
      ok: false,
      error: {
        kind: 'partial_failure',
        stripeProductId: product.stripeProductId,
        stripeRecurringPriceId: newRecurringPrice.id,
        stripeSetupPriceId: newSetupPriceId,
      },
    };
  }
}

export interface ReconcileStripeIds {
  stripeProductId: string;
  stripeRecurringPriceId: string | null;
  stripeSetupPriceId: string | null;
}

/**
 * Recovery path for a partial_failure: the Stripe objects already
 * exist (created by a prior bootstrap/reprice call whose local write
 * failed), so this ONLY persists them to Prisma — it never calls
 * Stripe again, to avoid creating a duplicate Product/Price on retry.
 */
export async function reconcileStripeProductForTier(
  productId: string,
  stripeIds: ReconcileStripeIds,
  actor: CatalogActor,
): Promise<CatalogMutationResult> {
  const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
  const before = auditSnapshot(product, product.stripePriceMode);

  const updated = await prisma.product.update({
    where: { id: product.id },
    data: {
      stripeProductId: stripeIds.stripeProductId,
      stripeRecurringPriceId: stripeIds.stripeRecurringPriceId,
      stripeSetupPriceId: stripeIds.stripeSetupPriceId,
    },
  });
  await prisma.stripeCatalogAudit.create({
    data: {
      productId: product.id,
      action: 'reconciled_after_partial_failure',
      before,
      after: auditSnapshot(updated, updated.stripePriceMode),
      actorOperatorId: actor.operatorId,
      actorEmail: actor.operatorEmail,
    },
  });
  return { ok: true, product: updated };
}

/** How many clients are actively subscribed to this tier right now —
 *  shown to an operator before confirming a reprice, since active
 *  subscribers keep their current price regardless. */
export async function countActiveSubscriptionsForProduct(productId: string): Promise<number> {
  return prisma.subscription.count({
    where: { status: { in: ['active', 'trialing'] }, clientProduct: { productId } },
  });
}
