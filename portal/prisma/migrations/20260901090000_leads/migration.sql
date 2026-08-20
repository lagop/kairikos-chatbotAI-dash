-- Migration: Leads ("Captación con IA" / 'leads' product) — Fase 1
--
-- Dos tablas nuevas:
--   Lead      — un contacto prospecto capturado durante una conversación
--               del chatbot. status libre (nuevo|contactado|convertido|
--               descartado), enforced en src/lib/leads.ts, no en la DB —
--               misma convención que WebQuote.status.
--   LeadAudit — mirror de ClientProductAudit (before/after status como
--               strings planos, un solo actor_id string), no de
--               WebQuoteAudit (que guarda JSON porque rastrea dinero —
--               un lead no tiene dinero que rastrear).
--
-- client_id/conversation_id sin @db.Uuid porque ChatbotClient.id y
-- ChatbotConversation.id son cuid() TEXT, como en el resto del schema.
-- conversation_id es SetNull (no Cascade): borrar la conversación origen
-- no debe borrar el lead que produjo.

CREATE TABLE "Lead" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "conversation_id" TEXT,
    "contact_name" TEXT,
    "contact_phone" TEXT,
    "contact_email" TEXT,
    "summary" TEXT,
    "score" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'nuevo',
    "channel" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "contacted_at" TIMESTAMP(3),
    "converted_at" TIMESTAMP(3),
    "discarded_at" TIMESTAMP(3),

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LeadAudit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lead_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "action" TEXT NOT NULL,
    "status_before" TEXT,
    "status_after" TEXT,
    "actor_id" TEXT NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadAudit_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Lead"
    ADD CONSTRAINT "Lead_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Lead"
    ADD CONSTRAINT "Lead_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Lead"
    ADD CONSTRAINT "Lead_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "ChatbotConversation"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "LeadAudit"
    ADD CONSTRAINT "LeadAudit_lead_id_fkey"
    FOREIGN KEY ("lead_id") REFERENCES "Lead"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeadAudit"
    ADD CONSTRAINT "LeadAudit_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeadAudit"
    ADD CONSTRAINT "LeadAudit_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Lead_client_id_status_idx" ON "Lead"("client_id", "status");
CREATE INDEX "Lead_client_id_created_at_idx" ON "Lead"("client_id", "created_at");
CREATE INDEX "Lead_tenant_id_idx" ON "Lead"("tenant_id");
CREATE INDEX "Lead_conversation_id_idx" ON "Lead"("conversation_id");

CREATE INDEX "LeadAudit_lead_id_changed_at_idx" ON "LeadAudit"("lead_id", "changed_at");
CREATE INDEX "LeadAudit_client_id_changed_at_idx" ON "LeadAudit"("client_id", "changed_at");
CREATE INDEX "LeadAudit_tenant_id_idx" ON "LeadAudit"("tenant_id");
