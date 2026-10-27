-- 27/10/2026 — qué colores y tipografías puede cambiar cada negocio sobre una
-- plantilla (SiteTemplateStyle, ver src/lib/site-style.ts). Columna nueva y
-- nula: el código anterior la ignora, así que se puede aplicar antes de
-- desplegar.
ALTER TABLE "SiteTemplate" ADD COLUMN "estilo" JSONB;
