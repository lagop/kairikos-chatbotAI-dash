-- La caché del gancho público de /seo/.
--
-- Escrita a mano: `prisma migrate dev` está roto en este repositorio (la
-- shadow database falla al reaplicar migraciones antiguas con
-- `function cuid() does not exist`). Se aplica con scripts/vps-migrate-deploy.sh.
--
-- Columnas en snake_case porque el modelo usa @map, igual que
-- ProspeccionZonaCache. Los modelos ANTIGUOS de este esquema no lo hacen — en
-- ChatbotConversation la columna es literalmente "clientId" — así que conviene
-- mirar el modelo antes de escribir el DDL y no deducirlo del estilo del
-- archivo.

CREATE TABLE "AuditoriaPublicaCache" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "url" TEXT NOT NULL,
    "tiene_titulo" BOOLEAN NOT NULL,
    "largo_titulo" INTEGER NOT NULL,
    "tiene_descripcion" BOOLEAN NOT NULL,
    "largo_descripcion" INTEGER NOT NULL,
    "h1" INTEGER NOT NULL,
    "imagenes" INTEGER NOT NULL,
    "imagenes_sin_alt" INTEGER NOT NULL,
    "ip_hash" TEXT NOT NULL,
    "mirado_el" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditoriaPublicaCache_pkey" PRIMARY KEY ("id")
);

-- Único: la URL normalizada es la clave de la caché.
CREATE UNIQUE INDEX "AuditoriaPublicaCache_url_key" ON "AuditoriaPublicaCache"("url");

-- Los dos topes cuentan filas por fecha, y el global las cuenta todas: sin
-- este índice, cada auditoría nueva hace un recorrido completo de la tabla.
CREATE INDEX "AuditoriaPublicaCache_mirado_el_idx" ON "AuditoriaPublicaCache"("mirado_el");
