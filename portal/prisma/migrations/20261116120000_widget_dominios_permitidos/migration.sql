-- Widget web: dominios permitidos por widget (16/11/2026).
--
-- allowed_origins vacía = sin restricción, que es lo que tenían todos los
-- widgets hasta hoy: la columna nace con '{}' para que ningún cliente note
-- el cambio. Ver src/lib/web-widget-origin.ts.

ALTER TABLE "ChatWebEmbed"
  ADD COLUMN "allowed_origins" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Auditoría append-only de los cambios del widget (hoy, solo la lista de
-- orígenes). Ver el modelo ChatWebEmbedAudit en schema.prisma.
CREATE TABLE "chat_web_embed_audit" (
    "id" UUID NOT NULL,
    "embed_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "actor_type" TEXT NOT NULL DEFAULT 'client',
    "actor_operator_id" UUID,
    "actor_email" TEXT,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_web_embed_audit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "chat_web_embed_audit_embed_id_changed_at_idx" ON "chat_web_embed_audit"("embed_id", "changed_at");
CREATE INDEX "chat_web_embed_audit_client_id_idx" ON "chat_web_embed_audit"("client_id");

ALTER TABLE "chat_web_embed_audit"
  ADD CONSTRAINT "chat_web_embed_audit_embed_id_fkey"
  FOREIGN KEY ("embed_id") REFERENCES "ChatWebEmbed"("id") ON DELETE CASCADE ON UPDATE CASCADE;
