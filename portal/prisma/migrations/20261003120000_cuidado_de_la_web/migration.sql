-- Plan de precios del 01/10/2026 — Cuidado de la web: alojamiento, dominio,
-- copias y cambios pequeños, 29 €/mes o 290 €/año. Un complemento
-- (kind 'addon') que se contrata POR WEB: un cliente con dos webs paga dos.
--
-- 1. La fila del catálogo. Sin ids de Stripe ni autoservicio genérico: se crea
--    en Stripe con «Crear en Stripe» del panel, y se contrata desde la página
--    de su web en el portal, nunca desde /empezar ni /portal/productos.
INSERT INTO "Product" ("id", "code", "tier", "name", "price_cents", "setup_fee_cents", "currency", "features", "is_active", "self_serve_eligible", "kind")
VALUES (gen_random_uuid(), 'web_care', 'standard', 'Cuidado de la web', 2900, 0, 'EUR', '{}'::jsonb, true, false, 'addon')
ON CONFLICT ("code", "tier") DO NOTHING;

-- 2. Multi-instancia: una contratación por web. Quinta vez que se reescribe
--    este índice parcial; mismo recurso que 20260930090000 (chatbot). El test
--    tests/unit/multi-instance-products.test.ts compara esta lista con
--    MULTI_INSTANCE_PRODUCT_CODES.
DO $$
DECLARE
    excluded_ids uuid[];
BEGIN
    SELECT array_agg(id) INTO excluded_ids
    FROM "Product" WHERE code IN ('web', 'seo', 'recall', 'chatbot', 'web_care');

    IF excluded_ids IS NULL OR array_length(excluded_ids, 1) IS NULL THEN
        RAISE NOTICE 'Sin esos productos en el catálogo: se deja el índice como estaba.';
        RETURN;
    END IF;

    EXECUTE 'DROP INDEX IF EXISTS "ClientProduct_client_id_product_id_single_instance_key"';
    EXECUTE format(
        'CREATE UNIQUE INDEX IF NOT EXISTS %I ON "ClientProduct" ("client_id", "product_id") WHERE "product_id" <> ALL (%L::uuid[])',
        'ClientProduct_client_id_product_id_single_instance_key',
        excluded_ids
    );
END $$;
