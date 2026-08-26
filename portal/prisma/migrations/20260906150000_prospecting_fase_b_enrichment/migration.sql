-- Prospección con IA, Fase B — enriquecimiento vía crawl de la web del
-- negocio (ver el plan de la sesión). Ambas columnas son aditivas y
-- nullable, sin default distinto de NULL: cada Lead existente queda
-- correctamente "sin enriquecer todavía" sin necesidad de backfill.

ALTER TABLE "Lead" ADD COLUMN "website" TEXT;
ALTER TABLE "Lead" ADD COLUMN "enrichment_requested_at" TIMESTAMP(3);
