-- Fase 1 multi-instancia, migración 1 de 4 — la entidad de sitio/negocio.
--
-- Cada contratación pasará a apuntar a uno de estos (migración 2). Ver
-- docs/plan-multi-instancia-fase-1.md para por qué un sitio compartido y no
-- asociaciones producto-a-producto.
--
-- Esta migración es puramente aditiva: crea una tabla que todavía nadie lee.

CREATE TABLE "client_site" (
    "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
    "client_id"   TEXT         NOT NULL,
    "tenant_id"   UUID,
    "name"        TEXT         NOT NULL,
    "site_url"    TEXT,
    "is_primary"  BOOLEAN      NOT NULL DEFAULT false,
    "archived_at" TIMESTAMP(3),
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_site_pkey" PRIMARY KEY ("id")
);

-- ChatbotClient.id es TEXT (@default(cuid())), no UUID — de los modelos
-- antiguos. Comprobado antes de escribir esto, no asumido.
ALTER TABLE "client_site"
    ADD CONSTRAINT "client_site_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "client_site"
    ADD CONSTRAINT "client_site_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "client_site_client_id_idx" ON "client_site" ("client_id");
CREATE INDEX "client_site_tenant_id_idx" ON "client_site" ("tenant_id");

-- Exactamente un sitio primario por cliente. Prisma no sabe expresar
-- "único donde is_primary" con @@unique, así que la garantía vive aquí y
-- SOLO aquí: si alguien regenera el esquema desde la base de datos, no la
-- verá en schema.prisma. Está anotada también en el comentario del modelo.
--
-- Mismo recurso que ya usa 20260901120000_client_product_web_multiplicity
-- para su índice parcial.
CREATE UNIQUE INDEX "client_site_one_primary_per_client"
    ON "client_site" ("client_id") WHERE "is_primary";
