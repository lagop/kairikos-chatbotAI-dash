-- Varias búsquedas por campaña de prospección (29/09/2026). Ver el modelo
-- ProspectingSearch en schema.prisma.
--
-- Aditiva: crea la tabla y COPIA a ella el rubro y la zona que cada campaña
-- tiene hoy, con su lastRunAt, para que el primer barrido después del
-- despliegue no trate como nueva una búsqueda que ya corrió. Las columnas
-- viejas de ProspectingCampaign (category, location_query, radius_meters)
-- NO se tocan: el contenedor anterior las sigue leyendo entre esta
-- migración y el despliegue. Se borrarán en una migración aparte.
--
-- Escrita a mano (`prisma migrate dev` está roto en este repositorio) y
-- aplicada ANTES de mergear con scripts/vps-migrate-deploy.sh y MIGRATE_BRANCH.

CREATE TABLE "ProspectingSearch" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "campaign_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "location_query" TEXT NOT NULL,
    "last_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProspectingSearch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProspectingSearch_campaign_id_category_location_query_key"
    ON "ProspectingSearch"("campaign_id", "category", "location_query");

CREATE INDEX "ProspectingSearch_campaign_id_idx" ON "ProspectingSearch"("campaign_id");

ALTER TABLE "ProspectingSearch"
    ADD CONSTRAINT "ProspectingSearch_campaign_id_fkey"
    FOREIGN KEY ("campaign_id") REFERENCES "ProspectingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- La búsqueda que cada campaña ya tenía, recortada igual que la guarda la
-- ruta. Las campañas sin rubro o sin zona (recién activadas, vacías) no
-- tienen nada que copiar.
INSERT INTO "ProspectingSearch" ("campaign_id", "category", "location_query", "last_run_at")
SELECT "id", btrim("category"), btrim("location_query"), "last_run_at"
FROM "ProspectingCampaign"
WHERE btrim(coalesce("category", '')) <> ''
  AND btrim(coalesce("location_query", '')) <> '';
