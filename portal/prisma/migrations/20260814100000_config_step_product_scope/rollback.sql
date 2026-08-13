-- Rollback: WP-13 — config step product scoping
--
-- Only safe if no client has two products' steps sharing a stepKey yet.
-- Check first:
--   SELECT "clientId", "stepKey", COUNT(DISTINCT "productCode")
--   FROM "ChatbotConfigStep"
--   GROUP BY "clientId", "stepKey"
--   HAVING COUNT(DISTINCT "productCode") > 1;
-- A non-empty result means re-adding the (clientId, stepKey, version) /
-- (clientId, stepKey) WHERE activeForBot unique constraints will fail
-- with a duplicate-key violation — resolve those rows (or their product
-- assignment) before running this.

BEGIN;

DROP INDEX IF EXISTS "ChatbotConfigStep_client_product_step_idx";

DROP INDEX IF EXISTS "ChatbotConfigStep_activeForBot_partial_uniq";
CREATE UNIQUE INDEX IF NOT EXISTS "ChatbotConfigStep_activeForBot_partial_uniq"
    ON "ChatbotConfigStep" ("clientId", "stepKey")
    WHERE "activeForBot" = true;

DROP INDEX IF EXISTS "ChatbotConfigStep_client_product_step_version_key";
CREATE UNIQUE INDEX IF NOT EXISTS "ChatbotConfigStep_clientId_stepKey_version_key"
    ON "ChatbotConfigStep" ("clientId", "stepKey", "version");

ALTER TABLE "ChatbotConfigStep" DROP COLUMN IF EXISTS "productCode";

COMMIT;
