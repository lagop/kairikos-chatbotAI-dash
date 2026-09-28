-- La caché de la foto de zona para el gancho público de /prospeccion/.
--
-- Escrita a mano: `prisma migrate dev` está roto en este repo — la shadow
-- database falla al reaplicar migraciones antiguas. Ver CLAUDE.md.
--
-- Los nombres de columna van en snake_case porque el modelo los mapea con
-- @map; el de la tabla NO se mapea, así que Postgres la guarda con el nombre
-- del modelo y entre comillas, como el resto de este esquema.

CREATE TABLE "ProspeccionZonaCache" (
    "id"        UUID         NOT NULL DEFAULT gen_random_uuid(),
    "rubro"     TEXT         NOT NULL,
    "provincia" TEXT         NOT NULL,
    "sin_web"   INTEGER      NOT NULL,
    "total"     INTEGER      NOT NULL,
    "ip_hash"   TEXT         NOT NULL,
    "mirado_el" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProspeccionZonaCache_pkey" PRIMARY KEY ("id")
);

-- Una fila por combinación. Es lo que convierte esto en una caché y no en un
-- registro que crece: el upsert de prospeccion-zona.ts depende de este índice.
CREATE UNIQUE INDEX "ProspeccionZonaCache_rubro_provincia_key"
    ON "ProspeccionZonaCache" ("rubro", "provincia");

-- Los dos topes diarios cuentan filas por fecha, y la caducidad también.
CREATE INDEX "ProspeccionZonaCache_mirado_el_idx"
    ON "ProspeccionZonaCache" ("mirado_el");
