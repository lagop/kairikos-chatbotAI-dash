-- Migration: WebBrief — standalone intake form for the 'web' product.
--
-- Deliberately NOT built on ChatbotConfigStep / the wizard engine (see the
-- schema.prisma model comment) — a single table, one row per client.

CREATE TABLE "WebBrief" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "business_name" TEXT,
    "vertical" TEXT,
    "goal" TEXT,
    "target_audience" TEXT,
    "has_existing_brand" BOOLEAN,
    "brand_assets_note" TEXT,
    "pages_needed" JSONB,
    "other_pages_note" TEXT,
    "content_provided_by" TEXT,
    "desired_domain" TEXT,
    "reference_websites" TEXT,
    "integrations_needed" JSONB,
    "other_integrations_note" TEXT,
    "additional_notes" TEXT,
    "submitted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebBrief_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WebBrief_client_id_key" ON "WebBrief"("client_id");
CREATE INDEX "WebBrief_tenant_id_idx" ON "WebBrief"("tenant_id");

ALTER TABLE "WebBrief"
    ADD CONSTRAINT "WebBrief_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WebBrief"
    ADD CONSTRAINT "WebBrief_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
