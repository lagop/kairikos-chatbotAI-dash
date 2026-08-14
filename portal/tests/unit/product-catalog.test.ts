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
  it('has exactly five distinct product codes', () => {
    const codes = new Set(PRODUCT_CATALOG.map((p) => p.code));
    expect(codes).toEqual(new Set(['chatbot', 'web', 'leads', 'seo', 'reviews']));
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

  it('reviews (Google reviews) is active — €99/mes, no setup fee', () => {
    const reviews = PRODUCT_CATALOG.find((p) => p.code === 'reviews');
    expect(reviews).toBeDefined();
    expect(reviews!.isActive).toBe(true);
    expect(reviews!.priceCents).toBe(9900);
    expect(reviews!.setupFeeCents).toBe(0);
  });

  it('every product is active and has a positive price component', () => {
    for (const p of PRODUCT_CATALOG) {
      expect(p.isActive).toBe(true);
      expect(p.priceCents + p.setupFeeCents).toBeGreaterThan(0);
    }
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
