-- 31/10/2026 — el logo y las fotos que el operador sube al borrador de un
-- prospecto (ProspectingWebDraftImage, lib/web-draft-images.ts).
CREATE TABLE IF NOT EXISTS "ProspectingWebDraftImage" (
    "id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProspectingWebDraftImage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ProspectingWebDraftImage_draft_id_path_key"
    ON "ProspectingWebDraftImage"("draft_id", "path");
CREATE INDEX IF NOT EXISTS "ProspectingWebDraftImage_draft_id_created_at_idx"
    ON "ProspectingWebDraftImage"("draft_id", "created_at");
DO $$ BEGIN
    ALTER TABLE "ProspectingWebDraftImage"
        ADD CONSTRAINT "ProspectingWebDraftImage_draft_id_fkey"
        FOREIGN KEY ("draft_id") REFERENCES "ProspectingWebDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
