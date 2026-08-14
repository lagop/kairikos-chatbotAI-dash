-- Rollback: WP-22b — campañas de solicitud de reseñas
DROP TABLE IF EXISTS "ReviewRequest";
DROP TABLE IF EXISTS "ReviewRequestCampaign";
ALTER TABLE "GoogleBusinessConnection" DROP COLUMN IF EXISTS "review_url";
