-- Fase 3 multi-instancia — Recall por línea telefónica.
--
-- El modelo de Recall ya estaba preparado, y conviene dejar escrito por qué:
-- RecallSubscription lleva client_product_id UNIQUE desde su propia fase, y
-- CallEvent, RecallDigest, RecallUsageMonth y RecallBlockedNumber cuelgan de
-- subscription_id, no del cliente. Una segunda línea es una segunda
-- contratación y todo lo operativo la sigue solo.
--
-- Lo que faltaba son dos cosas distintas:
--
--   1. La atribución de los recados (abajo, punto 1). ES LA PARTE QUE NO SE
--      PUEDE APLAZAR: un Job o un ServiceQuote creado sin línea no se puede
--      atribuir después. El contacto es de la PERSONA —la misma puede llamar
--      a los dos negocios del cliente—, así que no hay nada de lo que
--      deducirla. Por eso se añade antes de que exista la segunda línea.
--
--   2. Levantar la guarda de unicidad para 'recall' (punto 3).
--
-- Las tres tablas que ganan columna están VACÍAS en local y en producción
-- (comprobado el 18/09/2026: Job 0, ServiceQuote 0, OutboundMessage 0), así
-- que las dos obligatorias nacen NOT NULL sin backfill. Si dejaran de
-- estarlo, esto necesitaría el paso de siempre: nullable, backfill, NOT NULL.

-- 1. De qué línea vino cada recado y cada presupuesto.
--
-- Los dos caminos que los crean ya conocían la línea y la tiraban: la captura
-- por voz la tiene en JobCaptureDraft.subscription_id, y la importación de
-- CSV la tiene en su propia URL. Solo había que pasarla.
ALTER TABLE "Job"          ADD COLUMN "subscription_id" UUID NOT NULL;
ALTER TABLE "ServiceQuote" ADD COLUMN "subscription_id" UUID NOT NULL;

ALTER TABLE "Job"
    ADD CONSTRAINT "Job_subscription_id_fkey"
    FOREIGN KEY ("subscription_id") REFERENCES "RecallSubscription"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ServiceQuote"
    ADD CONSTRAINT "ServiceQuote_subscription_id_fkey"
    FOREIGN KEY ("subscription_id") REFERENCES "RecallSubscription"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Job_subscription_id_idx"          ON "Job" ("subscription_id");
CREATE INDEX "ServiceQuote_subscription_id_idx" ON "ServiceQuote" ("subscription_id");

-- 2. El libro mayor de envíos, para poder repartir el coste por línea.
--
-- NULLABLE, y no es un apaño: esta tabla la comparten los cuatro productos
-- (ver product_code) y un envío de prospección o de reseñas no tiene línea.
-- Hace falta porque el coste por línea no se puede reconstruir: call_event_id
-- solo existe en los envíos que nacen de una llamada, no en los códigos de
-- desvío ni en las campañas de recuperación.
ALTER TABLE "OutboundMessage" ADD COLUMN "subscription_id" UUID;

ALTER TABLE "OutboundMessage"
    ADD CONSTRAINT "OutboundMessage_subscription_id_fkey"
    FOREIGN KEY ("subscription_id") REFERENCES "RecallSubscription"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "OutboundMessage_subscription_id_idx" ON "OutboundMessage" ("subscription_id");

-- 3. Levantar la guarda de unicidad para 'recall'.
--
-- Tercera capa, la que no se ve desde el código de aplicación. Mismo recurso
-- que 20260901120000 (web) y 20260928090000 (seo): Postgres prohíbe
-- subconsultas en el predicado de un índice parcial, así que los ids se
-- resuelven una vez y se incrustan como literales vía un bloque DO.
--
-- Hay un test que compara esta lista de códigos con MULTI_INSTANCE_PRODUCT_CODES
-- (tests/unit/multi-instance-products.test.ts): separarlas hace reventar el
-- insert contra la base de datos, o deja la puerta abierta en silencio.
DO $$
DECLARE
    excluded_ids uuid[];
BEGIN
    SELECT array_agg(id) INTO excluded_ids FROM "Product" WHERE code IN ('web', 'seo', 'recall');

    IF excluded_ids IS NULL OR array_length(excluded_ids, 1) IS NULL THEN
        RAISE NOTICE 'Sin productos web/seo/recall en el catálogo: se deja el índice como estaba.';
        RETURN;
    END IF;

    EXECUTE 'DROP INDEX IF EXISTS "ClientProduct_client_id_product_id_single_instance_key"';

    EXECUTE format(
        'CREATE UNIQUE INDEX IF NOT EXISTS %I ON "ClientProduct" ("client_id", "product_id") WHERE "product_id" <> ALL (%L::uuid[])',
        'ClientProduct_client_id_product_id_single_instance_key',
        excluded_ids
    );
END $$;
