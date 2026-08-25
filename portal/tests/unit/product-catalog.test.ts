// =============================================================================
// WP-12 — unit tests for the PRODUCT_CATALOG seed data in prisma/seed.ts.
//
// Importing prisma/seed.ts must NOT touch a real database — the module
// guards its `main()` call behind an `isMain` check (see seed.ts) so this
// import only pulls in the plain PRODUCT_CATALOG array.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { PRODUCT_CATALOG } from '../../prisma/seed';

describe('PRODUCT_CATALOG', () => {
  it('has exactly six distinct product codes', () => {
    const codes = new Set(PRODUCT_CATALOG.map((p) => p.code));
    expect(codes).toEqual(new Set(['chatbot', 'web', 'leads', 'seo', 'reviews', 'recall']));
  });

  it('every (code, tier) pair is unique — matches the Product.@@unique([code, tier]) constraint', () => {
    const keys = PRODUCT_CATALOG.map((p) => `${p.code}:${p.tier}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('chatbot keeps its three tiers with their existing Stripe recurring price ids', () => {
    const chatbot = PRODUCT_CATALOG.filter((p) => p.code === 'chatbot');
    expect(chatbot.map((p) => p.tier).sort()).toEqual(['premium', 'pro', 'starter']);
    for (const p of chatbot) {
      expect(p.stripeRecurringPriceId).toBeTruthy();
      expect(p.priceCents).toBeGreaterThan(0);
    }
  });

  it('the web platform is one-time only: priceCents 0, setupFeeCents > 0', () => {
    const web = PRODUCT_CATALOG.find((p) => p.code === 'web');
    expect(web).toBeDefined();
    expect(web!.priceCents).toBe(0);
    expect(web!.setupFeeCents).toBeGreaterThan(0);
  });

  it('reviews (Google reviews) has two self-serve tiers matching kairikos.com/resenas-google', () => {
    const reviews = PRODUCT_CATALOG.filter((p) => p.code === 'reviews');
    expect(reviews.map((p) => p.tier).sort()).toEqual(['basic', 'pro']);
    for (const p of reviews) {
      expect(p.isActive).toBe(true);
      expect(p.stripeRecurringPriceId).toBeTruthy();
    }

    const basic = reviews.find((p) => p.tier === 'basic')!;
    expect(basic.priceCents).toBe(9900);
    expect(basic.setupFeeCents).toBe(9900);
    expect(basic.stripeSetupPriceId).toBeTruthy();

    const pro = reviews.find((p) => p.tier === 'pro')!;
    expect(pro.priceCents).toBe(14900);
    expect(pro.setupFeeCents).toBe(0);

    // Enterprise (custom pricing, not self-serve per the marketing page)
    // is deliberately NOT modeled as a Product row.
    expect(reviews.some((p) => p.tier === 'enterprise')).toBe(false);
  });

  it('recall (missed-call recovery) has three tiers priced by business size, each with its own Stripe price ids', () => {
    const recall = PRODUCT_CATALOG.filter((p) => p.code === 'recall');
    expect(recall.map((p) => p.tier).sort()).toEqual(['business', 'solo', 'team']);

    // Priced by business size, not by included minutes — see the seed
    // comment. Monotonically increasing on both axes.
    const bySize = ['solo', 'team', 'business'].map((t) => recall.find((p) => p.tier === t)!);
    expect(bySize.map((p) => p.priceCents)).toEqual([14900, 24900, 39900]);
    expect(bySize.map((p) => p.setupFeeCents)).toEqual([29000, 39000, 49000]);

    for (const p of recall) {
      // Product.stripeRecurringPriceId is @unique — a copied placeholder
      // id would break the seed on the second row.
      expect(p.stripeRecurringPriceId).toBeTruthy();
      expect(p.stripeSetupPriceId).toBeTruthy();
    }
  });

  it('every product has a positive price component', () => {
    for (const p of PRODUCT_CATALOG) {
      expect(p.priceCents + p.setupFeeCents).toBeGreaterThan(0);
    }
  });

  it('the only inactive products are the recall tiers, which are not sellable until Coexistence is verified', () => {
    // Deliberate: 'recall' depends on a WhatsApp path that has never run
    // against a real Meta app (see the plan's Fase 8). It must not be
    // purchasable — /portal/productos and the self-serve checkout both
    // filter on isActive — until that is proven. Flip the seed to
    // isActive: true then, and this assertion with it.
    const inactive = PRODUCT_CATALOG.filter((p) => !p.isActive);
    expect(new Set(inactive.map((p) => p.code))).toEqual(new Set(['recall']));
    expect(PRODUCT_CATALOG.filter((p) => p.code === 'recall').every((p) => !p.isActive)).toBe(true);
  });

  it('billing type derives correctly from priceCents/setupFeeCents for every entry', () => {
    for (const p of PRODUCT_CATALOG) {
      const isOneTime = p.priceCents === 0 && p.setupFeeCents > 0;
      const isSubscriptionPlusSetup = p.priceCents > 0 && p.setupFeeCents > 0;
      const isSubscriptionOnly = p.priceCents > 0 && p.setupFeeCents === 0;
      const isUnpublished = p.priceCents === 0 && p.setupFeeCents === 0;
      const matchesExactlyOne =
        [isOneTime, isSubscriptionPlusSetup, isSubscriptionOnly, isUnpublished].filter(Boolean).length === 1;
      expect(matchesExactlyOne).toBe(true);
    }
  });
});
