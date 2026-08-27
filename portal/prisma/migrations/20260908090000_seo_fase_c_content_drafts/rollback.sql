-- Rollback for 20260908090000_seo_fase_c_content_drafts.

DROP TABLE "SeoContentDraft";
ALTER TABLE "SeoProfile" DROP COLUMN "last_content_requested_at";
