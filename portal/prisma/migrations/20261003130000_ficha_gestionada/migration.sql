-- Plan de precios del 01/10/2026 — Ficha de Google gestionada: publicaciones
-- semanales y respuestas a las reseñas, 49 €/mes o 490 €/año, una por ficha.
--
-- 1. La fila del catálogo: complemento (kind 'addon'), sin ids de Stripe ni
--    autoservicio genérico. Se crea en Stripe desde el panel.
INSERT INTO "Product" ("id", "code", "tier", "name", "price_cents", "setup_fee_cents", "currency", "features", "is_active", "self_serve_eligible", "kind")
VALUES (gen_random_uuid(), 'gbp_managed', 'standard', 'Ficha de Google gestionada', 4900, 0, 'EUR', '{}'::jsonb, true, false, 'addon')
ON CONFLICT ("code", "tier") DO NOTHING;

-- 2. Qué contratación gestiona cada ficha.
ALTER TABLE "GoogleBusinessConnection" ADD COLUMN "managed_client_product_id" UUID;
CREATE UNIQUE INDEX "GoogleBusinessConnection_managed_client_product_id_key" ON "GoogleBusinessConnection"("managed_client_product_id");

-- 3. Las publicaciones semanales.
CREATE TABLE "GbpPost" (
    "id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "connection_id" UUID NOT NULL,
    "client_product_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'drafted',
    "summary" TEXT NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publish_after" TIMESTAMP(3) NOT NULL,
    "edited_at" TIMESTAMP(3),
    "published_by" TEXT,
    "published_at" TIMESTAMP(3),
    "google_post_name" TEXT,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GbpPost_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "GbpPost_connection_id_generated_at_idx" ON "GbpPost"("connection_id", "generated_at");
CREATE INDEX "GbpPost_status_publish_after_idx" ON "GbpPost"("status", "publish_after");
CREATE INDEX "GbpPost_client_id_idx" ON "GbpPost"("client_id");

-- 4. Multi-instancia: una por ficha. Sexta vez que se reescribe el índice
--    parcial de ClientProduct; el test tests/unit/multi-instance-products.test.ts
--    compara esta lista con MULTI_INSTANCE_PRODUCT_CODES.
DO $$
DECLARE
    excluded_ids uuid[];
BEGIN
    SELECT array_agg(id) INTO excluded_ids
    FROM "Product" WHERE code IN ('web', 'seo', 'recall', 'chatbot', 'web_care', 'gbp_managed');

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
