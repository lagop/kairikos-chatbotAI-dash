-- Chatbot — tope de mensajes contestados al mes, por contratación.
--
-- POR QUÉ: cada respuesta del bot es una llamada de pago al modelo y no había
-- techo en ninguna capa. El webhook del widget está abierto a internet, así que
-- con el token público de un widget se podía gastar sin límite.
--
-- Dos tablas: los topes que el operador edita (singleton, como SeoSettings) y
-- el contador por contratación (como ProspectingCampaign.leadsFoundThisMonth,
-- con su reinicio mensual perezoso, sin cron).

CREATE TABLE "ChatbotSettings" (
  "id"                          UUID PRIMARY KEY,
  "monthly_message_cap_starter" INTEGER NOT NULL DEFAULT 2000,
  "monthly_message_cap_pro"     INTEGER NOT NULL DEFAULT 6000,
  "monthly_message_cap_premium" INTEGER NOT NULL DEFAULT 15000,
  "updated_at"                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_by"                  TEXT
);

CREATE TABLE "ChatbotUsage" (
  "id"                  UUID PRIMARY KEY,
  "client_product_id"   UUID NOT NULL,
  -- TEXT y no UUID: ChatbotClient.id es texto en los modelos antiguos.
  "client_id"           TEXT NOT NULL,
  "tenant_id"           UUID,
  "messages_this_month" INTEGER NOT NULL DEFAULT 0,
  "usage_reset_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "cap_override"        INTEGER,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "ChatbotUsage_client_product_id_fkey"
    FOREIGN KEY ("client_product_id") REFERENCES "ClientProduct"("id") ON DELETE CASCADE,
  CONSTRAINT "ChatbotUsage_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id") ON DELETE CASCADE,
  CONSTRAINT "ChatbotUsage_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX "ChatbotUsage_client_product_id_key" ON "ChatbotUsage" ("client_product_id");
CREATE INDEX "ChatbotUsage_client_id_idx" ON "ChatbotUsage" ("client_id");
CREATE INDEX "ChatbotUsage_tenant_id_idx" ON "ChatbotUsage" ("tenant_id");
