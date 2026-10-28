-- 28/10/2026 — el logo y las fotos que sube el cliente (ClientWebsiteImage).
CREATE TABLE IF NOT EXISTS "ClientWebsiteImage" (
    "id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientWebsiteImage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ClientWebsiteImage_website_id_path_key"
    ON "ClientWebsiteImage"("website_id", "path");
CREATE INDEX IF NOT EXISTS "ClientWebsiteImage_website_id_created_at_idx"
    ON "ClientWebsiteImage"("website_id", "created_at");
ALTER TABLE "ClientWebsiteImage"
    ADD CONSTRAINT "ClientWebsiteImage_website_id_fkey"
    FOREIGN KEY ("website_id") REFERENCES "ClientWebsite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
