-- 31/10/2026 — historial de versiones del borrador pedido en kairikos.com
-- (PublicDraftVersion, lib/draft-versions.ts).
CREATE TABLE IF NOT EXISTS "PublicDraftVersion" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "accion" TEXT NOT NULL,
    "nota" TEXT,
    "actor_id" TEXT NOT NULL,
    "copy" JSONB,
    "content" JSONB,
    "template_id" UUID,
    "theme_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PublicDraftVersion_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "PublicDraftVersion_request_id_created_at_idx"
    ON "PublicDraftVersion"("request_id", "created_at");
DO $$ BEGIN
    ALTER TABLE "PublicDraftVersion"
        ADD CONSTRAINT "PublicDraftVersion_request_id_fkey"
        FOREIGN KEY ("request_id") REFERENCES "PublicDraftRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
