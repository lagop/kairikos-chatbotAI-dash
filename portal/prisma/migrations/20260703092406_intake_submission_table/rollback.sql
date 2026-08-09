-- Rollback: drop IntakeSubmission table (KAIA-2913)
--
-- Safe to run only when no ChatbotClient / ChatbotClientUser / external
-- system references the IntakeSubmission rows. The route handler treats
-- the table as the source of truth for the operator pipeline, so once
-- production data exists, prefer soft-archival (rename table) over DROP.

DROP INDEX IF EXISTS "IntakeSubmission_created_at_idx";
DROP INDEX IF EXISTS "IntakeSubmission_vertical_idx";
DROP INDEX IF EXISTS "IntakeSubmission_source_idx";
DROP INDEX IF EXISTS "IntakeSubmission_intake_slug_idx";
DROP INDEX IF EXISTS "IntakeSubmission_business_name_idx";
DROP INDEX IF EXISTS "IntakeSubmission_human_handoff_email_idx";
DROP INDEX IF EXISTS "IntakeSubmission_client_id_idx";

DROP TABLE IF EXISTS "IntakeSubmission";