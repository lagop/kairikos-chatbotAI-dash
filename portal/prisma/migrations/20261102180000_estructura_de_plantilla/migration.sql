-- 02/11/2026 — la estructura propia de la portada de una plantilla
-- (site-template-structure.ts). En la plantilla y en su historial, para que
-- aplicar una corrección o volver a una versión la lleve también.
ALTER TABLE "SiteTemplate" ADD COLUMN "estructura" JSONB;
ALTER TABLE "SiteTemplateVersion" ADD COLUMN "estructura" JSONB;
