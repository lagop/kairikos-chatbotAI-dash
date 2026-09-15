-- Fase 5d — suscripciones push, una por dispositivo.
--
-- Aditiva y sin backfill: nadie se ha suscrito todavía, porque hasta esta
-- migración no existía forma de hacerlo.

CREATE TABLE IF NOT EXISTS "PushSubscription" (
  "id"               UUID         NOT NULL,
  "client_id"        TEXT         NOT NULL,
  "tenant_id"        UUID,
  "user_email"       TEXT         NOT NULL,
  "endpoint"         TEXT         NOT NULL,
  "p256dh"           TEXT         NOT NULL,
  "auth"             TEXT         NOT NULL,
  "user_agent"       TEXT,
  "last_success_at"  TIMESTAMP(3),
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PushSubscription"
  ADD CONSTRAINT "PushSubscription_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "PushSubscription_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- El mismo dispositivo re-suscribiéndose actualiza, no duplica.
CREATE UNIQUE INDEX IF NOT EXISTS "PushSubscription_endpoint_key" ON "PushSubscription" ("endpoint");
CREATE INDEX IF NOT EXISTS "PushSubscription_client_id_idx"  ON "PushSubscription" ("client_id");
CREATE INDEX IF NOT EXISTS "PushSubscription_user_email_idx" ON "PushSubscription" ("user_email");
CREATE INDEX IF NOT EXISTS "PushSubscription_tenant_id_idx"  ON "PushSubscription" ("tenant_id");
