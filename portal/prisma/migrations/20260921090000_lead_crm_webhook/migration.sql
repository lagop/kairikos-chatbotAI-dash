-- Fase 4 — webhook saliente hacia el CRM del cliente.
--
-- Tabla nueva, nada existente cambia. ChannelWebhookDelivery se reutiliza
-- tal cual para el rastro y los reintentos: su propio comentario ya dice
-- que connectionType es libre y que «deliverChannelEvent doesn't care
-- which, it's the same delivery+retry plumbing either way».

CREATE TABLE "LeadWebhook" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_delivery_at" TIMESTAMP(3),
    "last_delivery_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadWebhook_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LeadWebhook_client_id_key" ON "LeadWebhook"("client_id");
CREATE INDEX "LeadWebhook_tenant_id_idx" ON "LeadWebhook"("tenant_id");

ALTER TABLE "LeadWebhook" ADD CONSTRAINT "LeadWebhook_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeadWebhook" ADD CONSTRAINT "LeadWebhook_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
