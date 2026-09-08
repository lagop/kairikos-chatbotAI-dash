-- "Sistema IA de captación" — producto completo. LeadQualificationProfile
-- es el mismo patrón que SeoProfile/ProspectingCampaign: formulario simple
-- del cliente, no el motor de wizard (ver el plan de la sesión). Añade
-- también leads_classified_at a ChatbotConversation, el marcador que usa
-- el cron sweep (lib/leads.ts) para no reclasificar la misma conversación.

CREATE TABLE "LeadQualificationProfile" (
    "id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_product_id" UUID NOT NULL,
    "tenant_id" UUID,
    "perfil_cliente_ideal" TEXT,
    "senales_descarte" TEXT,
    "email_aviso" TEXT,
    "classifications_this_month" INTEGER NOT NULL DEFAULT 0,
    "usage_reset_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadQualificationProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LeadQualificationProfile_client_id_key" ON "LeadQualificationProfile"("client_id");
CREATE UNIQUE INDEX "LeadQualificationProfile_client_product_id_key" ON "LeadQualificationProfile"("client_product_id");
CREATE INDEX "LeadQualificationProfile_client_id_idx" ON "LeadQualificationProfile"("client_id");
CREATE INDEX "LeadQualificationProfile_tenant_id_idx" ON "LeadQualificationProfile"("tenant_id");

ALTER TABLE "LeadQualificationProfile"
    ADD CONSTRAINT "LeadQualificationProfile_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LeadQualificationProfile"
    ADD CONSTRAINT "LeadQualificationProfile_client_product_id_fkey"
    FOREIGN KEY ("client_product_id") REFERENCES "ClientProduct"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LeadQualificationProfile"
    ADD CONSTRAINT "LeadQualificationProfile_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "LeadQualificationProfileAudit" (
    "id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "actor_email" TEXT NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadQualificationProfileAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LeadQualificationProfileAudit_profile_id_changed_at_idx" ON "LeadQualificationProfileAudit"("profile_id", "changed_at");
CREATE INDEX "LeadQualificationProfileAudit_client_id_changed_at_idx" ON "LeadQualificationProfileAudit"("client_id", "changed_at");
CREATE INDEX "LeadQualificationProfileAudit_tenant_id_idx" ON "LeadQualificationProfileAudit"("tenant_id");

ALTER TABLE "LeadQualificationProfileAudit"
    ADD CONSTRAINT "LeadQualificationProfileAudit_profile_id_fkey"
    FOREIGN KEY ("profile_id") REFERENCES "LeadQualificationProfile"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeadQualificationProfileAudit"
    ADD CONSTRAINT "LeadQualificationProfileAudit_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeadQualificationProfileAudit"
    ADD CONSTRAINT "LeadQualificationProfileAudit_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ChatbotConversation" ADD COLUMN "leads_classified_at" TIMESTAMP(3);

CREATE INDEX "ChatbotConversation_clientId_leads_classified_at_idx" ON "ChatbotConversation"("clientId", "leads_classified_at");
