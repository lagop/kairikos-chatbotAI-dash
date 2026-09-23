-- A11, capa 1 · Borrador de web de un prospecto.
--
-- Mismos nombres que ProspectingCompetitorSnapshot: tabla en PascalCase,
-- columnas en snake_case por @map. "Lead" es modelo antiguo pero su tabla
-- también va con mayúscula — comprobado antes de escribir esto.

CREATE TABLE IF NOT EXISTS "ProspectingWebDraft" (
    "id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "copy" JSONB NOT NULL,
    "theme_key" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProspectingWebDraft_pkey" PRIMARY KEY ("id")
);

-- 1:1 con el lead: regenerar sustituye la fila, no acumula. Es también lo que
-- hace posible el upsert por leadId.
CREATE UNIQUE INDEX IF NOT EXISTS "ProspectingWebDraft_lead_id_key"
    ON "ProspectingWebDraft"("lead_id");

CREATE INDEX IF NOT EXISTS "ProspectingWebDraft_client_id_generated_at_idx"
    ON "ProspectingWebDraft"("client_id", "generated_at");

CREATE INDEX IF NOT EXISTS "ProspectingWebDraft_tenant_id_idx"
    ON "ProspectingWebDraft"("tenant_id");

ALTER TABLE "ProspectingWebDraft"
    ADD CONSTRAINT "ProspectingWebDraft_lead_id_fkey"
    FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProspectingWebDraft"
    ADD CONSTRAINT "ProspectingWebDraft_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProspectingWebDraft"
    ADD CONSTRAINT "ProspectingWebDraft_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
