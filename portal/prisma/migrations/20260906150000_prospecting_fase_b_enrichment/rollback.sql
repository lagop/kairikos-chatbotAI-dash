-- Rollback for 20260906150000_prospecting_fase_b_enrichment.

ALTER TABLE "Lead" DROP COLUMN "enrichment_requested_at";
ALTER TABLE "Lead" DROP COLUMN "website";
