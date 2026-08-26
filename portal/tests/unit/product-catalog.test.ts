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
  it('has exactly seven distinct product codes', () => {
    const codes = new Set(PRODUCT_CATALOG.map((p) => p.code));
    expect(codes).toEqual(new Set(['chatbot', 'web', 'leads', 'seo', 'reviews', 'recall', 'prospecting']));
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

  it('prospecting (active lead discovery) has three tiers priced above leads, each with its own Stripe price ids', () => {
    const prospecting = PRODUCT_CATALOG.filter((p) => p.code === 'prospecting');
    expect(prospecting.map((p) => p.tier).sort()).toEqual(['business', 'solo', 'team']);

    const bySize = ['solo', 'team', 'business'].map((t) => prospecting.find((p) => p.tier === t)!);
    expect(bySize.map((p) => p.priceCents)).toEqual([12900, 21900, 34900]);
    // Setup fee is flat across tiers — unlike recall, Fase A's onboarding
    // is client self-serve (a form), not operator provisioning work that
    // scales with tier.
    expect(bySize.every((p) => p.setupFeeCents === 9900)).toBe(true);

    const leadsPriceCents = PRODUCT_CATALOG.find((p) => p.code === 'leads')!.priceCents;
    expect(bySize[1].priceCents).toBeGreaterThan(leadsPriceCents);
    expect(bySize[2].priceCents).toBeGreaterThan(leadsPriceCents);

    for (const p of prospecting) {
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

  it('recall is on sale, ahead of Coexistence being verified — a deliberate business call, not an oversight', () => {
    // 2026-08-25: the user made this call explicitly, twice, aware that
    // Coexistence (Fase 8) has not run against a real Meta app yet. Do
    // not flip this back to inactive without asking first.
    //
    // What still gates a real purchase is the Stripe side, not this
    // flag: stripeRecurringPriceId/stripeSetupPriceId below are
    // placeholders until an operator runs Bootstrap for these three
    // tiers at /admin/portal/settings/billing. See that route's own
    // tests (stripe-catalog.test.ts) for the placeholder-id lifecycle.
    const recall = PRODUCT_CATALOG.filter((p) => p.code === 'recall');
    expect(recall).toHaveLength(3);
    expect(recall.every((p) => p.isActive)).toBe(true);
  });

  it('every product in the catalogue is active — none should be silently unsellable', () => {
    // An inactive row is invisible on /portal/productos and rejected by
    // the self-serve checkout. That has to be a deliberate, commented
    // decision (like recall's above, while it lasted) — never a default
    // a new entry falls into by omission.
    const inactive = PRODUCT_CATALOG.filter((p) => !p.isActive);
    expect(inactive).toEqual([]);
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
