-- Migration: WP-22c — respuestas asistidas por IA a reseñas

ALTER TABLE "GoogleReview" ADD COLUMN IF NOT EXISTS "ai_draft_reply" TEXT;
ALTER TABLE "GoogleReview" ADD COLUMN IF NOT EXISTS "ai_draft_generated_at" TIMESTAMP(3);
ALTER TABLE "GoogleReview" ADD COLUMN IF NOT EXISTS "reply_approved_by" TEXT;
ALTER TABLE "GoogleReview" ADD COLUMN IF NOT EXISTS "reply_approved_at" TIMESTAMP(3);
ALTER TABLE "GoogleReview" ADD COLUMN IF NOT EXISTS "reply_published_at" TIMESTAMP(3);

ALTER TABLE "GoogleBusinessConnection" ADD COLUMN IF NOT EXISTS "auto_publish_replies" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "GoogleBusinessConnection" ADD COLUMN IF NOT EXISTS "auto_publish_replies_changed_by" TEXT;
ALTER TABLE "GoogleBusinessConnection" ADD COLUMN IF NOT EXISTS "auto_publish_replies_changed_at" TIMESTAMP(3);
