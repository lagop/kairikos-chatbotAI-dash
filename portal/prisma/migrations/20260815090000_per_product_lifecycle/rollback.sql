-- Rollback: WP-14 — per-product onboarding lifecycle
--
-- Only removes the two new columns and repoints ChatbotActivity's unique
-- key back to (clientId, milestone). Does NOT delete the ClientProduct
-- rows the migration's step 3a inserted — by the time anyone rolls this
-- back, those rows may be the only record of a real client's product
-- assignment (created via the admin UI in the meantime), and this
-- migration has no way to distinguish "created by 3a" from "created by a
-- human after". If a client now has two products sharing the same
-- (clientId, milestone) pair, re-adding the old unique constraint will
-- fail with a duplicate-key violation — check first:
--   SELECT "clientId", "milestone", COUNT(*) FROM "ChatbotActivity"
--   GROUP BY "clientId", "milestone" HAVING COUNT(*) > 1;

BEGIN;

DROP INDEX IF EXISTS "ChatbotActivity_clientId_productCode_idx";
DROP INDEX IF EXISTS "ChatbotActivity_client_product_milestone_key";
ALTER TABLE "ChatbotActivity"
    ADD CONSTRAINT "ChatbotActivity_clientId_milestone_key" UNIQUE ("clientId", "milestone");
ALTER TABLE "ChatbotActivity" DROP COLUMN IF EXISTS "productCode";

ALTER TABLE "ClientProduct"
    DROP COLUMN IF EXISTS "go_live_at",
    DROP COLUMN IF EXISTS "onboarding_state";

COMMIT;
