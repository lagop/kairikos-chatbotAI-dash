-- Rollback for 20260908180000_seo_profile_cadence_override.

ALTER TABLE "SeoProfile" DROP COLUMN "content_generation_min_interval_days_override";
