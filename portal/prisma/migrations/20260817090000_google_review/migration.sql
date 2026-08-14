-- Migration: WP-22a — conectar cuenta y sincronizar reseñas
--
-- New table GoogleReview: one row per review synced from a client's
-- connected Google Business Profile location. `google_review_id` (the
-- review's full Google resource name) is the idempotency key —
-- syncReviewsForConnection always upserts on it, so a retried or
-- overlapping sync run can never create a duplicate row.
--
-- Reversibility: see rollback.sql — a straight DROP, safe as long as no
-- sync run has landed real reviews yet.

CREATE TABLE "GoogleReview" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "connection_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "google_review_id" TEXT NOT NULL,
    "reviewer_name" TEXT,
    "star_rating" INTEGER NOT NULL,
    "comment" TEXT,
    "create_time" TIMESTAMP(3) NOT NULL,
    "update_time" TIMESTAMP(3) NOT NULL,
    "reply_comment" TEXT,
    "reply_updated_at" TIMESTAMP(3),
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoogleReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GoogleReview_google_review_id_key" ON "GoogleReview"("google_review_id");

ALTER TABLE "GoogleReview"
    ADD CONSTRAINT "GoogleReview_connection_id_fkey"
    FOREIGN KEY ("connection_id") REFERENCES "GoogleBusinessConnection"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GoogleReview"
    ADD CONSTRAINT "GoogleReview_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GoogleReview"
    ADD CONSTRAINT "GoogleReview_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "GoogleReview_connection_id_idx" ON "GoogleReview"("connection_id");
CREATE INDEX "GoogleReview_client_id_idx" ON "GoogleReview"("client_id");
CREATE INDEX "GoogleReview_star_rating_idx" ON "GoogleReview"("star_rating");
