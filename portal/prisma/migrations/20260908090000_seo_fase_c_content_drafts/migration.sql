-- SEO con IA, Fase C — SeoContentDraft (borradores generados por IA,
-- revision del operador) + SeoProfile.last_content_requested_at (gate de
-- cadencia mensual). Ver el comentario del modelo en schema.prisma.

ALTER TABLE "SeoProfile" ADD COLUMN "last_content_requested_at" TIMESTAMP(3);

CREATE TABLE "SeoContentDraft" (
    "id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "title" TEXT,
    "body_html" TEXT,
    "target_keyword" TEXT,
    "meta_description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending_generation',
    "source_signals" JSONB,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generated_at" TIMESTAMP(3),
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "published_at" TIMESTAMP(3),
    "wordpress_post_id" TEXT,
    "wordpress_post_url" TEXT,
    "publish_error" TEXT,

    CONSTRAINT "SeoContentDraft_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SeoContentDraft_profile_id_idx" ON "SeoContentDraft"("profile_id");
CREATE INDEX "SeoContentDraft_client_id_idx" ON "SeoContentDraft"("client_id");
CREATE INDEX "SeoContentDraft_status_idx" ON "SeoContentDraft"("status");

ALTER TABLE "SeoContentDraft"
    ADD CONSTRAINT "SeoContentDraft_profile_id_fkey"
    FOREIGN KEY ("profile_id") REFERENCES "SeoProfile"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SeoContentDraft"
    ADD CONSTRAINT "SeoContentDraft_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SeoContentDraft"
    ADD CONSTRAINT "SeoContentDraft_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
