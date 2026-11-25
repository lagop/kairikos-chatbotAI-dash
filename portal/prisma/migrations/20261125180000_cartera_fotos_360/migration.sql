-- Cartera: fotos 360° de cada casa (25/11/2026). Como cartera_photo, sin
-- texto alternativo; el fichero vive en el mismo volumen (cartera-fotos).

-- CreateTable
CREATE TABLE "cartera_pano" (
    "id" UUID NOT NULL,
    "home_id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cartera_pano_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cartera_pano_storage_key_key" ON "cartera_pano"("storage_key");

-- CreateIndex
CREATE INDEX "cartera_pano_home_id_position_idx" ON "cartera_pano"("home_id", "position");

-- AddForeignKey
ALTER TABLE "cartera_pano" ADD CONSTRAINT "cartera_pano_home_id_fkey" FOREIGN KEY ("home_id") REFERENCES "cartera_home"("id") ON DELETE CASCADE ON UPDATE CASCADE;
