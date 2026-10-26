-- 26/10/2026 — caducidad del contenido de Google Places (lib/places-retention.ts).
--
-- Solo añade columnas que admiten nulos y rellena una fecha: no borra nada.
-- La purga la hace el cron /api/cron/places-retention, no esta migración.

ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "places_fetched_at" TIMESTAMP(3);
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "places_purged_at" TIMESTAMP(3);
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "phone_hash" TEXT;
-- 'not_found' | 'closed': Google ya no da ese negocio al volver a pedirlo.
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "places_unavailable" TEXT;

-- Los leads que vinieron de Places se trajeron el día que se crearon: es la
-- mejor fecha que hay, y sin ella la purga no sabría cuándo caducan.
UPDATE "Lead" SET "places_fetched_at" = "created_at"
 WHERE "external_place_id" IS NOT NULL AND "places_fetched_at" IS NULL;

CREATE INDEX IF NOT EXISTS "Lead_places_fetched_at_idx" ON "Lead"("places_fetched_at");
CREATE INDEX IF NOT EXISTS "Lead_phone_hash_idx" ON "Lead"("phone_hash");

ALTER TABLE "ProspectingCompetitorSnapshot" ADD COLUMN IF NOT EXISTS "purged_at" TIMESTAMP(3);
