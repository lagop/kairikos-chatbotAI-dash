-- Webs con IA, entrega 1 (27/10/2026): plantillas de diseño y contenido v2.
-- Todo nullable o con valor por defecto: las webs que ya existen siguen
-- saliendo de "copy" + "theme_key" sin cambiar nada.

CREATE TABLE "SiteTemplate" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "nombre" TEXT NOT NULL,
    "sector" TEXT,
    "variante" TEXT,
    "origen" TEXT NOT NULL DEFAULT 'manual',
    "modelo" TEXT,
    "marco" TEXT NOT NULL,
    "secciones" JSONB NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'borrador',
    "validacion" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SiteTemplate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SiteTemplate_sector_estado_idx" ON "SiteTemplate"("sector", "estado");

ALTER TABLE "ClientWebsite" ADD COLUMN "content" JSONB;
ALTER TABLE "ClientWebsite" ADD COLUMN "template_id" UUID;
CREATE INDEX "ClientWebsite_template_id_idx" ON "ClientWebsite"("template_id");
ALTER TABLE "ClientWebsite" ADD CONSTRAINT "ClientWebsite_template_id_fkey"
    FOREIGN KEY ("template_id") REFERENCES "SiteTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ClientWebsiteRelease" ADD COLUMN "content" JSONB;
ALTER TABLE "ClientWebsiteRelease" ADD COLUMN "template_id" UUID;
