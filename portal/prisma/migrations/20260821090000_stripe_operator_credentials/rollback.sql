-- Rollback: removes the Stripe credential/catalog-audit infrastructure.
-- Safe as a direct DROP while no credential or audit row has been
-- written yet. If a credential was already saved, this destroys it — it
-- would need to be re-pasted after a forward-migrate.

DROP TABLE IF EXISTS "StripeCatalogAudit";
DROP TABLE IF EXISTS "StripeOperatorCredential";
ALTER TABLE "Product" DROP COLUMN IF EXISTS "stripe_price_mode";
ALTER TABLE "Product" DROP COLUMN IF EXISTS "stripe_product_id";
