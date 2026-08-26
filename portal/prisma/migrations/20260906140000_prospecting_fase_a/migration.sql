-- Prospección con IA, Fase A — investigación activa de leads via Google
-- Places, sin contacto automático (ver el plan de la sesión).
--
-- Lead.source/externalPlaceId son aditivos: source por defecto 'inbound'
-- así que cada fila existente queda correctamente clasificada sin tocarla.
-- externalPlaceId es nullable y solo se rellena para leads 'outbound'.

ALTER TABLE "Lead" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'inbound';
ALTER TABLE "Lead" ADD COLUMN "external_place_id" TEXT;

CREATE UNIQUE INDEX "Lead_client_id_external_place_id_key" ON "Lead"("client_id", "external_place_id");

CREATE TABLE "ProspectingCampaign" (
    "id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_product_id" UUID NOT NULL,
    "tenant_id" UUID,
    "category" TEXT,
    "location_query" TEXT,
    "radius_meters" INTEGER DEFAULT 10000,
    "status" TEXT NOT NULL DEFAULT 'active',
    "last_run_at" TIMESTAMP(3),
    "leads_found_this_month" INTEGER NOT NULL DEFAULT 0,
    "monthly_lead_cap" INTEGER NOT NULL,
    "usage_reset_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "alerted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProspectingCampaign_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProspectingCampaign_client_product_id_key" ON "ProspectingCampaign"("client_product_id");
CREATE INDEX "ProspectingCampaign_client_id_idx" ON "ProspectingCampaign"("client_id");
CREATE INDEX "ProspectingCampaign_tenant_id_idx" ON "ProspectingCampaign"("tenant_id");
CREATE INDEX "ProspectingCampaign_status_idx" ON "ProspectingCampaign"("status");

ALTER TABLE "ProspectingCampaign"
    ADD CONSTRAINT "ProspectingCampaign_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProspectingCampaign"
    ADD CONSTRAINT "ProspectingCampaign_client_product_id_fkey"
    FOREIGN KEY ("client_product_id") REFERENCES "ClientProduct"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProspectingCampaign"
    ADD CONSTRAINT "ProspectingCampaign_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ProspectingCampaignAudit" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "actor_id" TEXT NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProspectingCampaignAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProspectingCampaignAudit_campaign_id_changed_at_idx" ON "ProspectingCampaignAudit"("campaign_id", "changed_at");
CREATE INDEX "ProspectingCampaignAudit_client_id_changed_at_idx" ON "ProspectingCampaignAudit"("client_id", "changed_at");
CREATE INDEX "ProspectingCampaignAudit_tenant_id_idx" ON "ProspectingCampaignAudit"("tenant_id");

ALTER TABLE "ProspectingCampaignAudit"
    ADD CONSTRAINT "ProspectingCampaignAudit_campaign_id_fkey"
    FOREIGN KEY ("campaign_id") REFERENCES "ProspectingCampaign"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProspectingCampaignAudit"
    ADD CONSTRAINT "ProspectingCampaignAudit_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProspectingCampaignAudit"
    ADD CONSTRAINT "ProspectingCampaignAudit_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
