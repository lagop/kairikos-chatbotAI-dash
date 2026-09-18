-- Fase 2 multi-instancia — SEO para varias webs del mismo cliente.
--
-- El modelo de datos de SEO ya estaba casi listo, y conviene dejar escrito por
-- qué: las métricas son únicas por connectionId (no por cliente), las palabras
-- clave por profileId, y SeoProfile ya iba por client_product_id desde su fase
-- A. Todo cuelga de DOS raíces, y solo esas dos estaban ancladas al cliente:
--
--   GoogleSeoConnection.client_id        UNIQUE   ← un cliente, una propiedad
--   GoogleAnalyticsConnection.client_id  UNIQUE   ← un cliente, una propiedad
--
-- Mover esas dos claves arrastra a todo lo demás sin tocarlo.
--
-- Por qué la conexión es de una web y no del cliente: searchConsoleSiteUrl y
-- propertyId identifican la propiedad de UN sitio. Un cliente con dos webs
-- necesita dos conexiones — mismo Google, dos autorizaciones, cada una con su
-- refresh token. Reutilizar una sola conexión obligaría a guardar N
-- propiedades por fila y a decidir cuál corresponde a cuál, que es la maraña
-- que este eje evita.
--
-- Las dos tablas están VACÍAS (0 filas en local y en producción, comprobado el
-- 18/09/2026), así que la columna nueva puede nacer NOT NULL sin backfill ni
-- ventana intermedia. Si alguna vez dejaran de estarlo, esto necesitaría el
-- paso de siempre: nullable → backfill → NOT NULL.

-- 1. Search Console.
ALTER TABLE "GoogleSeoConnection" DROP CONSTRAINT IF EXISTS "GoogleSeoConnection_client_id_key";
DROP INDEX IF EXISTS "GoogleSeoConnection_client_id_key";

ALTER TABLE "GoogleSeoConnection" ADD COLUMN "client_product_id" UUID NOT NULL;

ALTER TABLE "GoogleSeoConnection"
    ADD CONSTRAINT "GoogleSeoConnection_client_product_id_fkey"
    FOREIGN KEY ("client_product_id") REFERENCES "ClientProduct"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "GoogleSeoConnection_client_product_id_key"
    ON "GoogleSeoConnection" ("client_product_id");
CREATE INDEX "GoogleSeoConnection_client_id_idx"
    ON "GoogleSeoConnection" ("client_id");

-- 2. Analytics (GA4).
ALTER TABLE "GoogleAnalyticsConnection" DROP CONSTRAINT IF EXISTS "GoogleAnalyticsConnection_client_id_key";
DROP INDEX IF EXISTS "GoogleAnalyticsConnection_client_id_key";

ALTER TABLE "GoogleAnalyticsConnection" ADD COLUMN "client_product_id" UUID NOT NULL;

ALTER TABLE "GoogleAnalyticsConnection"
    ADD CONSTRAINT "GoogleAnalyticsConnection_client_product_id_fkey"
    FOREIGN KEY ("client_product_id") REFERENCES "ClientProduct"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "GoogleAnalyticsConnection_client_product_id_key"
    ON "GoogleAnalyticsConnection" ("client_product_id");
CREATE INDEX "GoogleAnalyticsConnection_client_id_idx"
    ON "GoogleAnalyticsConnection" ("client_id");

-- 3. Levantar la guarda de unicidad PARA 'seo', y solo para 'seo'.
--
-- Ésta es la tercera capa, la que no se ve desde el código de aplicación: un
-- índice único parcial que impone "una contratación por (cliente, producto)"
-- excluyendo a 'web'. Aquí se reescribe para excluir también a 'seo'.
--
-- Postgres prohíbe subconsultas en el predicado de un índice parcial, así que
-- los ids se resuelven una vez y se incrustan como literales vía un bloque DO
-- — mismo recurso, y misma razón, que
-- 20260901120000_client_product_web_multiplicity.
--
-- OJO: el predicado va sobre product_id, que identifica código Y TARIFA. Si
-- 'seo' tuviera varias tarifas habría que excluirlas todas; hoy tiene una
-- ('standard'), y el bucle de abajo las recorre igualmente para no depender de
-- que siga siendo así.
DO $$
DECLARE
    excluded_ids uuid[];
    predicate    text;
BEGIN
    SELECT array_agg(id) INTO excluded_ids FROM "Product" WHERE code IN ('web', 'seo');

    IF excluded_ids IS NULL OR array_length(excluded_ids, 1) IS NULL THEN
        RAISE NOTICE 'Sin productos web/seo en el catálogo: se deja el índice como estaba.';
        RETURN;
    END IF;

    EXECUTE 'DROP INDEX IF EXISTS "ClientProduct_client_id_product_id_non_web_key"';
    EXECUTE 'DROP INDEX IF EXISTS "ClientProduct_client_id_product_id_single_instance_key"';

    predicate := format('"product_id" <> ALL (%L::uuid[])', excluded_ids);
    EXECUTE format(
        'CREATE UNIQUE INDEX IF NOT EXISTS %I ON "ClientProduct" ("client_id", "product_id") WHERE %s',
        'ClientProduct_client_id_product_id_single_instance_key',
        predicate
    );
END $$;
