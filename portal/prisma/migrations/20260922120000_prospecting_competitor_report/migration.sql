-- A1 · Informe de prospección con comparativa de competidores.
--
-- Ojo con los nombres de columna: "Lead" es un modelo ANTIGUO y sus
-- columnas propias van en snake_case por @map ("external_place_id",
-- "search_category"), pero la tabla misma se llama "Lead" con mayúscula.
-- Comprobado contra el modelo antes de escribir esto.

ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "latitude" DOUBLE PRECISION;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "longitude" DOUBLE PRECISION;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "primary_type" TEXT;

CREATE TABLE IF NOT EXISTS "ProspectingCompetitorSnapshot" (
    "id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "subject_rating" DOUBLE PRECISION,
    "subject_review_count" INTEGER,
    "competitors" JSONB NOT NULL,
    "metrics" JSONB NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProspectingCompetitorSnapshot_pkey" PRIMARY KEY ("id")
);

-- 1:1 con el lead: refrescar la foto sustituye la fila, no acumula
-- historial. Es también lo que hace posible el upsert por leadId.
CREATE UNIQUE INDEX IF NOT EXISTS "ProspectingCompetitorSnapshot_lead_id_key"
    ON "ProspectingCompetitorSnapshot"("lead_id");

CREATE INDEX IF NOT EXISTS "ProspectingCompetitorSnapshot_client_id_captured_at_idx"
    ON "ProspectingCompetitorSnapshot"("client_id", "captured_at");

CREATE INDEX IF NOT EXISTS "ProspectingCompetitorSnapshot_tenant_id_idx"
    ON "ProspectingCompetitorSnapshot"("tenant_id");

ALTER TABLE "ProspectingCompetitorSnapshot"
    ADD CONSTRAINT "ProspectingCompetitorSnapshot_lead_id_fkey"
    FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProspectingCompetitorSnapshot"
    ADD CONSTRAINT "ProspectingCompetitorSnapshot_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProspectingCompetitorSnapshot"
    ADD CONSTRAINT "ProspectingCompetitorSnapshot_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
