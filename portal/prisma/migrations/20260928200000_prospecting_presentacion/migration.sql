-- «Nos dedicamos a …»: el {{3}} del primer mensaje de Prospección
-- (prospecting_first_contact_v2). Ver lib/prospecting-presentacion.ts.
--
-- Aditiva y nullable: ninguna fila existente cambia, y una campaña sin ella
-- simplemente no envía primeros mensajes hasta que el cliente la rellene.
--
-- Escrita a mano (`prisma migrate dev` está roto en este repositorio) y
-- aplicada ANTES de mergear con scripts/vps-migrate-deploy.sh y MIGRATE_BRANCH.
-- El campo no lleva @map, así que la columna se llama igual que el campo.

ALTER TABLE "ProspectingCampaign" ADD COLUMN "presentacion" TEXT;
