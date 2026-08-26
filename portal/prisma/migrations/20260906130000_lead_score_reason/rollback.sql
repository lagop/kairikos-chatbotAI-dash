-- Rollback for 20260906130000_lead_score_reason.

ALTER TABLE "Lead" DROP COLUMN IF EXISTS "score_reason";
