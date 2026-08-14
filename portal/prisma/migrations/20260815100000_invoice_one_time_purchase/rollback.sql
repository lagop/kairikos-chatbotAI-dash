-- Rollback: WP-19 — facturación por producto (alta, cuota y pago único)
--
-- Only safe if no one-time-purchase invoice has been created yet — check
-- first:
--   SELECT COUNT(*) FROM "Invoice" WHERE "client_product_id" IS NOT NULL;
-- If that's > 0, re-adding NOT NULL on subscription_id will fail (those
-- rows have no subscription_id) and those rows would need a manual
-- decision (delete them, or leave subscription_id nullable) before this
-- rollback can proceed.

BEGIN;

ALTER TABLE "Invoice" DROP CONSTRAINT IF EXISTS "Invoice_client_product_id_fkey";
DROP INDEX IF EXISTS "Invoice_client_product_id_idx";
ALTER TABLE "Invoice" DROP COLUMN IF EXISTS "client_product_id";

ALTER TABLE "Invoice" ALTER COLUMN "subscription_id" SET NOT NULL;

COMMIT;
