-- Rollback for 20260906140000_prospecting_fase_a.
-- Only run this if Prospección con IA Fase A is being reverted entirely.

DROP TABLE IF EXISTS "ProspectingCampaignAudit";
DROP TABLE IF EXISTS "ProspectingCampaign";

DROP INDEX IF EXISTS "Lead_client_id_external_place_id_key";
ALTER TABLE "Lead" DROP COLUMN IF EXISTS "external_place_id";
ALTER TABLE "Lead" DROP COLUMN IF EXISTS "source";
