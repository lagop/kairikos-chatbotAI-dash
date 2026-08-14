-- Rollback: WP-12 — Product multi-service catalog
--
-- Inverse of migration.sql. Only safe to run if every row still has a
-- single, distinct `tier` across all products (i.e. no two products
-- share a tier value yet) — otherwise re-adding the global UNIQUE on
-- `tier` will fail with a constraint violation. Check with:
--   SELECT tier, COUNT(*) FROM "Product" GROUP BY tier HAVING COUNT(*) > 1;
-- before running this.

BEGIN;

DO $do$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'Product_stripe_recurring_price_id_key') THEN
        ALTER INDEX "Product_stripe_recurring_price_id_key" RENAME TO "Product_stripe_price_id_key";
    END IF;
END $do$;

DO $do$ BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'Product' AND column_name = 'stripe_recurring_price_id'
    ) THEN
        ALTER TABLE "Product" RENAME COLUMN "stripe_recurring_price_id" TO "stripe_price_id";
    END IF;
END $do$;

ALTER TABLE "Product"
    DROP COLUMN IF EXISTS "stripe_setup_price_id",
    DROP COLUMN IF EXISTS "setup_fee_cents";

DROP INDEX IF EXISTS "Product_code_tier_key";
ALTER TABLE "Product" ADD CONSTRAINT "Product_tier_key" UNIQUE ("tier");

DROP INDEX IF EXISTS "Product_code_idx";
ALTER TABLE "Product" DROP COLUMN IF EXISTS "code";

COMMIT;
