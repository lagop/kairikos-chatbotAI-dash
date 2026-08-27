-- Rollback for 20260906190000_seo_fase_a_audit.

ALTER TABLE "SeoProfile" DROP COLUMN "last_audit_error";
ALTER TABLE "SeoProfile" DROP COLUMN "last_audit_result";
ALTER TABLE "SeoProfile" DROP COLUMN "last_audit_at";
