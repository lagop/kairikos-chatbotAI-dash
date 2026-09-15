-- Fase 3 — campañas de recuperación con aprobación humana.
--
-- Ambas nacen vacías: no hay campañas históricas que reconstruir, y
-- fabricar una a partir de mensajes ya enviados sería inventarse una
-- aprobación que nunca ocurrió.

CREATE TABLE IF NOT EXISTS "RecoveryCampaign" (
  "id"                       UUID         NOT NULL,
  "client_id"                TEXT         NOT NULL,
  "tenant_id"                UUID,
  "subscription_id"          UUID         NOT NULL,
  "trigger"                  TEXT         NOT NULL,
  "status"                   TEXT         NOT NULL DEFAULT 'draft',
  "approved_by_operator_id"  UUID,
  "approved_at"              TIMESTAMP(3),
  "completed_at"             TIMESTAMP(3),
  "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"               TIMESTAMP(3) NOT NULL,

  CONSTRAINT "RecoveryCampaign_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "RecoveryCampaignMember" (
  "id"                UUID         NOT NULL,
  "campaign_id"       UUID         NOT NULL,
  "contact_id"        UUID         NOT NULL,
  "e164"              TEXT         NOT NULL,
  "state"             TEXT         NOT NULL DEFAULT 'pending',
  "excluded_reason"   TEXT,
  "reason"            TEXT         NOT NULL,
  "job_id"            UUID,
  "service_quote_id"  UUID,
  "sent_at"           TIMESTAMP(3),
  "error"             TEXT,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RecoveryCampaignMember_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "RecoveryCampaign"
  ADD CONSTRAINT "RecoveryCampaign_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "RecoveryCampaign_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  -- SET NULL y no CASCADE: si se borra la cuenta del operador que aprobó,
  -- la campaña NO desaparece. approvedAt se queda, y con él la constancia
  -- de que alguien la aprobó — que es justo lo que no puede evaporarse.
  ADD CONSTRAINT "RecoveryCampaign_approved_by_operator_id_fkey"
    FOREIGN KEY ("approved_by_operator_id") REFERENCES "Operator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- El miembro SÍ cae con su campaña y con su contacto: fuera de la campaña
-- no significa nada, y un miembro cuyo contacto se borró por retención es
-- un número de teléfono huérfano que ya no debemos conservar.
ALTER TABLE "RecoveryCampaignMember"
  ADD CONSTRAINT "RecoveryCampaignMember_campaign_id_fkey"
    FOREIGN KEY ("campaign_id") REFERENCES "RecoveryCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "RecoveryCampaignMember_contact_id_fkey"
    FOREIGN KEY ("contact_id") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "RecoveryCampaign_client_id_status_idx"  ON "RecoveryCampaign" ("client_id", "status");
CREATE INDEX IF NOT EXISTS "RecoveryCampaign_status_created_at_idx" ON "RecoveryCampaign" ("status", "created_at");
CREATE INDEX IF NOT EXISTS "RecoveryCampaign_tenant_id_idx"         ON "RecoveryCampaign" ("tenant_id");

-- Una persona, una vez por campaña.
CREATE UNIQUE INDEX IF NOT EXISTS "RecoveryCampaignMember_campaign_id_contact_id_key"
  ON "RecoveryCampaignMember" ("campaign_id", "contact_id");
CREATE INDEX IF NOT EXISTS "RecoveryCampaignMember_campaign_id_state_idx" ON "RecoveryCampaignMember" ("campaign_id", "state");
CREATE INDEX IF NOT EXISTS "RecoveryCampaignMember_contact_id_idx"        ON "RecoveryCampaignMember" ("contact_id");
