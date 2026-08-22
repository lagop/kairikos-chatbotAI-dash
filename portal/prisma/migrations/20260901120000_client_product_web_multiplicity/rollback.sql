-- Rollback for 20260901120000_client_product_web_multiplicity.
-- Only safe to run if no client has acquired a second 'web' ClientProduct
-- row since this migration applied — the restored UNIQUE constraint would
-- otherwise fail to create.

DROP INDEX IF EXISTS "ClientProduct_client_id_product_id_non_web_key";
DROP INDEX IF EXISTS "ClientProduct_client_id_product_id_idx";

ALTER TABLE "ClientProduct"
    ADD CONSTRAINT "ClientProduct_client_id_product_id_key"
    UNIQUE ("client_id", "product_id");
