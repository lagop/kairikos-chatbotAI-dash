-- =============================================================================
-- WP-09 — rollback for 02-migration.sql.
--
-- Inverse of the NOT NULL + DEFAULT changes. Backfilled tenant_id values
-- are NOT un-backfilled — there is no record of which rows were NULL
-- before 02-migration.sql ran, so this only undoes the constraint, not
-- the data. Take a snapshot before running 02-migration.sql if you need
-- true point-in-time recovery.
-- =============================================================================

BEGIN;

ALTER TABLE "ChatbotClient"          ALTER COLUMN "tenant_id" DROP NOT NULL;
ALTER TABLE "ChatbotClientUser"      ALTER COLUMN "tenant_id" DROP NOT NULL;
ALTER TABLE "ChatbotActivity"        ALTER COLUMN "tenant_id" DROP NOT NULL;
ALTER TABLE "ChatbotConversation"    ALTER COLUMN "tenant_id" DROP NOT NULL;
ALTER TABLE "ChatbotConfigStep"      ALTER COLUMN "tenant_id" DROP NOT NULL;
ALTER TABLE "ChatbotConfigStepAudit" ALTER COLUMN "tenant_id" DROP NOT NULL;
ALTER TABLE "ClientProduct"          ALTER COLUMN "tenant_id" DROP NOT NULL;
ALTER TABLE "ClientProductAudit"     ALTER COLUMN "tenant_id" DROP NOT NULL;

ALTER TABLE "ChatbotClient"          ALTER COLUMN "tenant_id" DROP DEFAULT;
ALTER TABLE "ChatbotClientUser"      ALTER COLUMN "tenant_id" DROP DEFAULT;
ALTER TABLE "ChatbotActivity"        ALTER COLUMN "tenant_id" DROP DEFAULT;
ALTER TABLE "ChatbotConversation"    ALTER COLUMN "tenant_id" DROP DEFAULT;
ALTER TABLE "ChatbotConfigStep"      ALTER COLUMN "tenant_id" DROP DEFAULT;
ALTER TABLE "ChatbotConfigStepAudit" ALTER COLUMN "tenant_id" DROP DEFAULT;
ALTER TABLE "ClientProduct"          ALTER COLUMN "tenant_id" DROP DEFAULT;
ALTER TABLE "ClientProductAudit"     ALTER COLUMN "tenant_id" DROP DEFAULT;

COMMIT;
