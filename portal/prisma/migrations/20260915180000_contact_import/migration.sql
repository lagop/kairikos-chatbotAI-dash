-- Fase 4 — registro de importaciones de datos pasados.

CREATE TABLE IF NOT EXISTS "ContactImport" (
  "id"                 UUID         NOT NULL,
  "client_id"          TEXT         NOT NULL,
  "tenant_id"          UUID,
  "filename"           TEXT,
  "legal_declaration"  TEXT         NOT NULL,
  "declared_by"        TEXT         NOT NULL,
  "quality_snapshot"   JSONB        NOT NULL,
  "contacts_created"   INTEGER      NOT NULL DEFAULT 0,
  "contacts_updated"   INTEGER      NOT NULL DEFAULT 0,
  "jobs_created"       INTEGER      NOT NULL DEFAULT 0,
  "rows_skipped"       INTEGER      NOT NULL DEFAULT 0,
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ContactImport_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ContactImport"
  ADD CONSTRAINT "ContactImport_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ContactImport_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "ContactImport_client_id_created_at_idx" ON "ContactImport" ("client_id", "created_at");
CREATE INDEX IF NOT EXISTS "ContactImport_tenant_id_idx"            ON "ContactImport" ("tenant_id");
