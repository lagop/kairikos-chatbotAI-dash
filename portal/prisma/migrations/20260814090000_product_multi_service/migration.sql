-- Migration: WP-12 — Product pasa de "una fila por tier" a catálogo real
--
-- Kairikos sells five products (chatbot, web platform, AI lead capture,
-- SEO, Google reviews), not one — but Product.tier was @unique, so the
-- table could only ever represent three rows (one per chatbot tier).
-- This migration:
--   1. Adds `code` (backfilled to 'chatbot' for every existing row via
--      DEFAULT, so the ALTER COLUMN SET NOT NULL below never sees a NULL
--      without a second UPDATE pass — same idiom as WP-09's tenant_id).
--   2. Replaces the global UNIQUE on `tier` with a compound UNIQUE on
--      (code, tier) — a tier is only unique WITHIN a product.
--   3. Adds `setup_fee_cents` (one-time onboarding fee) and
--      `stripe_setup_price_id`, alongside the existing recurring price
--      column, renamed from `stripe_price_id` to `stripe_recurring_price_id`
--      so its name says what it actually bills. Billing type is derived
--      from price_cents/setup_fee_cents at read time, not stored — see
--      the WP-12 comment on the Product model in schema.prisma.
--
-- Purely additive + a rename; no data is dropped. Product rows for the
-- four new codes are created by `prisma/seed.ts` (dev/QA convenience),
-- not by this migration — this migration only prepares the schema.
--
-- Reversibility: see rollback.sql. Column defaults make this safe to
-- apply against a live database without breaking existing reads: every
-- caller of Product.stripePriceId is updated in the same PR to read
-- stripeRecurringPriceId, so the rename lands atomically with the code
-- that depends on it.

-- ============================================================================
-- 1. code
-- ============================================================================
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "code" TEXT;
UPDATE "Product" SET "code" = 'chatbot' WHERE "code" IS NULL;
ALTER TABLE "Product" ALTER COLUMN "code" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "Product_code_idx" ON "Product" ("code");

-- ============================================================================
-- 2. tier: global UNIQUE -> compound UNIQUE (code, tier)
-- ============================================================================
DROP INDEX IF EXISTS "Product_tier_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Product_code_tier_key" ON "Product" ("code", "tier");

-- ============================================================================
-- 3. Setup fee + rename the recurring-price column
-- ============================================================================
ALTER TABLE "Product"
    ADD COLUMN IF NOT EXISTS "setup_fee_cents" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "stripe_setup_price_id" TEXT;

DO $do$ BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'Product' AND column_name = 'stripe_price_id'
    ) THEN
        ALTER TABLE "Product" RENAME COLUMN "stripe_price_id" TO "stripe_recurring_price_id";
    END IF;
END $do$;

DO $do$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'Product_stripe_price_id_key') THEN
        ALTER INDEX "Product_stripe_price_id_key" RENAME TO "Product_stripe_recurring_price_id_key";
    END IF;
END $do$;
