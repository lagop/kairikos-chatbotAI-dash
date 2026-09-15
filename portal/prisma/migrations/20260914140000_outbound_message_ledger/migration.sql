-- Fase 0 — libro mayor de mensajes salientes.
--
-- Sin backfill: no hay de dónde sacarlo. RecallUsageMonth guarda totales
-- por mes y no sabe de qué categoría era cada mensaje, que es justamente
-- lo que esta tabla existe para registrar. El histórico anterior a esta
-- migración se queda como está — agregado y sin desglose — y eso es
-- exactamente lo que este cambio impide que siga pasando.

CREATE TABLE IF NOT EXISTS "OutboundMessage" (
  -- Sin DEFAULT en la base: el id lo pone Prisma (@default(uuid())), que
  -- es la convención de todas las tablas de este esquema. Un default de
  -- servidor aquí generaría deriva contra el schema.
  "id"                  UUID         NOT NULL,
  "client_id"           TEXT         NOT NULL,
  "tenant_id"           UUID,
  "product_code"        TEXT         NOT NULL,
  "channel"             TEXT         NOT NULL,
  "kind"                TEXT         NOT NULL,
  "category"            TEXT,
  "template_name"       TEXT,
  "to_e164"             TEXT         NOT NULL,
  "provider_message_id" TEXT,
  "cost_amount"         DECIMAL(12,6),
  "cost_currency"       TEXT,
  "cost_synced_at"      TIMESTAMP(3),
  "ok"                  BOOLEAN      NOT NULL,
  "error"               TEXT,
  "call_event_id"       UUID,
  "sent_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OutboundMessage_pkey" PRIMARY KEY ("id")
);

-- ON DELETE: el cliente se lleva sus mensajes por delante (CASCADE), pero
-- el tenant y la llamada solo se desenganchan (SET NULL). Borrar la
-- llamada por retención NO puede borrar el registro de lo que costó
-- atenderla: el dato de coste sobrevive al dato personal, que es
-- precisamente lo que permite conservar la contabilidad después de
-- cumplir con el borrado.
ALTER TABLE "OutboundMessage"
  ADD CONSTRAINT "OutboundMessage_client_id_fkey"
  FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OutboundMessage"
  ADD CONSTRAINT "OutboundMessage_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OutboundMessage"
  ADD CONSTRAINT "OutboundMessage_call_event_id_fkey"
  FOREIGN KEY ("call_event_id") REFERENCES "CallEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "OutboundMessage_client_id_sent_at_idx"
  ON "OutboundMessage" ("client_id", "sent_at");

CREATE INDEX IF NOT EXISTS "OutboundMessage_cost_synced_at_sent_at_idx"
  ON "OutboundMessage" ("cost_synced_at", "sent_at");

CREATE INDEX IF NOT EXISTS "OutboundMessage_tenant_id_idx"
  ON "OutboundMessage" ("tenant_id");

CREATE INDEX IF NOT EXISTS "OutboundMessage_call_event_id_idx"
  ON "OutboundMessage" ("call_event_id");
