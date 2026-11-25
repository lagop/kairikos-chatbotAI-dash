-- RGPD, encargo del tratamiento (25/11/2026): auditoría de lo que se hace con los
-- datos que Kairikos trata por cuenta del cliente (exportaciones, retención, bajas).
-- Tabla nueva y vacía: no toca ninguna existente.
--
-- client_product_id va SIN clave foránea a propósito: la fila tiene que
-- sobrevivir a la purga de la contratación que describe. La del cliente sí,
-- con RESTRICT, como en "ClientProductAudit".
-- OJO: "ChatbotClient" es de las tablas antiguas; su clave es "id".
CREATE TABLE "client_data_audit" (
    "id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_product_id" UUID,
    "tenant_id" UUID,
    "product_code" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_data_audit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "client_data_audit_client_id_created_at_idx" ON "client_data_audit"("client_id", "created_at");

CREATE INDEX "client_data_audit_action_created_at_idx" ON "client_data_audit"("action", "created_at");

ALTER TABLE "client_data_audit" ADD CONSTRAINT "client_data_audit_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
