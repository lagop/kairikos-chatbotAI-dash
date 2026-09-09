-- Fase 3 — seguimiento de la entrega del producto 'web'.
--
-- Aditiva. Las tres columnas de WebQuote son nullable y la tabla es nueva:
-- ningún presupuesto existente cambia de comportamiento, y uno sin filas
-- de etapas se lee como «todas pendientes» (el catálogo manda, ver
-- buildDeliveryProgress).

ALTER TABLE "WebQuote" ADD COLUMN "preview_url" TEXT;
ALTER TABLE "WebQuote" ADD COLUMN "delivered_at" TIMESTAMP(3);
ALTER TABLE "WebQuote" ADD COLUMN "delivery_accepted_at" TIMESTAMP(3);

CREATE TABLE "WebProjectMilestone" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "web_quote_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebProjectMilestone_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WebProjectMilestone_web_quote_id_key_key" ON "WebProjectMilestone"("web_quote_id", "key");
CREATE INDEX "WebProjectMilestone_client_id_idx" ON "WebProjectMilestone"("client_id");
CREATE INDEX "WebProjectMilestone_tenant_id_idx" ON "WebProjectMilestone"("tenant_id");

ALTER TABLE "WebProjectMilestone" ADD CONSTRAINT "WebProjectMilestone_web_quote_id_fkey" FOREIGN KEY ("web_quote_id") REFERENCES "WebQuote"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebProjectMilestone" ADD CONSTRAINT "WebProjectMilestone_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebProjectMilestone" ADD CONSTRAINT "WebProjectMilestone_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
