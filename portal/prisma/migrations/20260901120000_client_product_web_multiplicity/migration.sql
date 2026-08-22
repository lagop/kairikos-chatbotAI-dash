-- WP-XX — Phase 1 of "multiple web projects per client". Drops the
-- blanket (client_id, product_id) uniqueness on ClientProduct and replaces
-- it with:
--   1. a plain index (for query performance — the compound-key Prisma
--      lookups this backed are being rewritten to findFirst/findMany), and
--   2. a partial unique index that keeps the real DB-level guarantee for
--      every product code EXCEPT 'web' — Postgres forbids subqueries in a
--      partial index's WHERE predicate, so the 'web' product's id is
--      resolved once and inlined as a literal via a DO block.
--
-- No data migration needed: today's data is 100% single-row-per-client for
-- every code (including 'web'), so both the plain index and the new
-- partial unique index apply cleanly against existing rows.

ALTER TABLE "ClientProduct" DROP CONSTRAINT "ClientProduct_client_id_product_id_key";

CREATE INDEX IF NOT EXISTS "ClientProduct_client_id_product_id_idx"
    ON "ClientProduct" ("client_id", "product_id");

DO $$
DECLARE
    web_product_id uuid;
BEGIN
    SELECT id INTO web_product_id FROM "Product" WHERE code = 'web' LIMIT 1;
    IF web_product_id IS NOT NULL THEN
        EXECUTE format(
            'CREATE UNIQUE INDEX IF NOT EXISTS %I ON "ClientProduct" ("client_id", "product_id") WHERE "product_id" <> %L',
            'ClientProduct_client_id_product_id_non_web_key',
            web_product_id
        );
    END IF;
END $$;
