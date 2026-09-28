-- La caché del gancho público de /prospeccion/: «¿Qué vendes?».
--
-- Escrita a mano: `prisma migrate dev` está roto en este repositorio (la
-- shadow database falla al reaplicar migraciones antiguas). Se aplica con
-- scripts/vps-migrate-deploy.sh y MIGRATE_BRANCH, ANTES de mergear, para que
-- el código llegue a una base de datos que ya tiene la tabla.
--
-- Columnas en snake_case porque el modelo usa @map. Los modelos antiguos de
-- este esquema no lo hacen, así que hay que mirar el modelo antes de escribir
-- el DDL y no deducirlo del estilo del archivo.

CREATE TABLE "QueVendesCache" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clave" TEXT NOT NULL,
    "a_quien" TEXT[],
    "ip_hash" TEXT NOT NULL,
    "creado_el" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QueVendesCache_pkey" PRIMARY KEY ("id")
);

-- La clave de la caché: un hash del texto normalizado más la provincia.
CREATE UNIQUE INDEX "QueVendesCache_clave_key" ON "QueVendesCache"("clave");

-- Los dos topes cuentan filas por fecha, y el global las cuenta todas: sin
-- este índice cada consulta nueva recorre la tabla entera.
CREATE INDEX "QueVendesCache_creado_el_idx" ON "QueVendesCache"("creado_el");
