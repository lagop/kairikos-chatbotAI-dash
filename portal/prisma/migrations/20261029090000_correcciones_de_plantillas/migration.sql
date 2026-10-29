-- 29/10/2026 — correcciones de plantillas aprobadas y su historial. Ver
-- SiteTemplate.correccionDe y SiteTemplateVersion en schema.prisma.
ALTER TABLE "SiteTemplate" ADD COLUMN "correccion_de" UUID;

CREATE INDEX "SiteTemplate_correccion_de_idx" ON "SiteTemplate"("correccion_de");

ALTER TABLE "SiteTemplate" ADD CONSTRAINT "SiteTemplate_correccion_de_fkey" FOREIGN KEY ("correccion_de") REFERENCES "SiteTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SiteTemplateVersion" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "marco" TEXT NOT NULL,
    "secciones" JSONB NOT NULL,
    "estilo" JSONB,
    "motivo" TEXT,
    "correccion_id" UUID,
    "actor_email" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteTemplateVersion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SiteTemplateVersion_template_id_created_at_idx" ON "SiteTemplateVersion"("template_id", "created_at");

ALTER TABLE "SiteTemplateVersion" ADD CONSTRAINT "SiteTemplateVersion_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "SiteTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
