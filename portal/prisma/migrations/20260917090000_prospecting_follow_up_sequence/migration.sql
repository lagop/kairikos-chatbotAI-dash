-- Fase 3.3 y 3.4 — secuencia de seguimiento y atribución de la búsqueda.
--
-- Todas las columnas son aditivas, nullable o con default seguro. Las
-- filas existentes quedan con follow_up_count = 0: los leads outbound ya
-- contactados antes de esta migración se ven como "sin ningún toque", así
-- que la secuencia les mandaría un primer contacto que ya recibieron. Por
-- eso el UPDATE de abajo: cualquier lead outbound que ya tenga
-- contacted_at cuenta como un toque hecho, y su reloj de espera arranca
-- en esa misma fecha.

ALTER TABLE "Lead" ADD COLUMN "follow_up_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Lead" ADD COLUMN "last_auto_contact_at" TIMESTAMP(3);
ALTER TABLE "Lead" ADD COLUMN "replied_at" TIMESTAMP(3);
ALTER TABLE "Lead" ADD COLUMN "search_category" TEXT;
ALTER TABLE "Lead" ADD COLUMN "search_location" TEXT;

UPDATE "Lead"
   SET "follow_up_count" = 1,
       "last_auto_contact_at" = "contacted_at"
 WHERE "source" = 'outbound'
   AND "contacted_at" IS NOT NULL;

CREATE INDEX "Lead_client_id_source_contacted_at_idx" ON "Lead"("client_id", "source", "contacted_at");
