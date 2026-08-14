-- Rollback: WP-22c — respuestas asistidas por IA a reseñas

ALTER TABLE "GoogleReview" DROP COLUMN IF EXISTS "ai_draft_reply";
ALTER TABLE "GoogleReview" DROP COLUMN IF EXISTS "ai_draft_generated_at";
ALTER TABLE "GoogleReview" DROP COLUMN IF EXISTS "reply_approved_by";
ALTER TABLE "GoogleReview" DROP COLUMN IF EXISTS "reply_approved_at";
ALTER TABLE "GoogleReview" DROP COLUMN IF EXISTS "reply_published_at";

ALTER TABLE "GoogleBusinessConnection" DROP COLUMN IF EXISTS "auto_publish_replies";
ALTER TABLE "GoogleBusinessConnection" DROP COLUMN IF EXISTS "auto_publish_replies_changed_by";
ALTER TABLE "GoogleBusinessConnection" DROP COLUMN IF EXISTS "auto_publish_replies_changed_at";
