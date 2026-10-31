-- 31/10/2026 — el logo y las fotos que el operador sube al borrador que pidió
-- un negocio en kairikos.com (PublicDraftImage, lib/web-draft-images.ts).
CREATE TABLE IF NOT EXISTS "PublicDraftImage" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PublicDraftImage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PublicDraftImage_request_id_path_key"
    ON "PublicDraftImage"("request_id", "path");
CREATE INDEX IF NOT EXISTS "PublicDraftImage_request_id_created_at_idx"
    ON "PublicDraftImage"("request_id", "created_at");
DO $$ BEGIN
    ALTER TABLE "PublicDraftImage"
        ADD CONSTRAINT "PublicDraftImage_request_id_fkey"
        FOREIGN KEY ("request_id") REFERENCES "PublicDraftRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
