-- Fase 2b — el borrador que espera confirmación del profesional.

CREATE TABLE IF NOT EXISTS "JobCaptureDraft" (
  "id"                UUID         NOT NULL,
  "client_id"         TEXT         NOT NULL,
  "tenant_id"         UUID,
  "subscription_id"   UUID         NOT NULL,
  "transcript"        TEXT         NOT NULL,
  "extracted"         JSONB        NOT NULL,
  "kind"              TEXT         NOT NULL,
  "contact_id"        UUID,
  "status"            TEXT         NOT NULL DEFAULT 'pending',
  "job_id"            UUID,
  "service_quote_id"  UUID,
  "expires_at"        TIMESTAMP(3) NOT NULL,
  "resolved_at"       TIMESTAMP(3),
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL,

  CONSTRAINT "JobCaptureDraft_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "JobCaptureDraft"
  ADD CONSTRAINT "JobCaptureDraft_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "JobCaptureDraft_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "JobCaptureDraft_contact_id_fkey"
    FOREIGN KEY ("contact_id") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- "El borrador vivo de esta suscripción": la única consulta en caliente.
CREATE INDEX IF NOT EXISTS "JobCaptureDraft_subscription_id_status_created_at_idx"
  ON "JobCaptureDraft" ("subscription_id", "status", "created_at");
CREATE INDEX IF NOT EXISTS "JobCaptureDraft_client_id_idx"  ON "JobCaptureDraft" ("client_id");
CREATE INDEX IF NOT EXISTS "JobCaptureDraft_tenant_id_idx"  ON "JobCaptureDraft" ("tenant_id");
CREATE INDEX IF NOT EXISTS "JobCaptureDraft_contact_id_idx" ON "JobCaptureDraft" ("contact_id");
