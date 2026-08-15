-- Migration: operator-managed Stripe credentials + catalog bootstrap/reprice
-- audit trail. See prisma/schema.prisma's StripeOperatorCredential and
-- StripeCatalogAudit model comments for the full design rationale.
--
-- Reversible via rollback.sql — safe as a direct DROP while no credential
-- or audit row has been written yet (the expected state right after this
-- deploy, before any operator has used the new settings screen).

ALTER TABLE "Product" ADD COLUMN "stripe_product_id" TEXT;
ALTER TABLE "Product" ADD COLUMN "stripe_price_mode" TEXT;

CREATE TABLE "StripeOperatorCredential" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "active_mode" TEXT,
    "test_secret_key_ciphertext" BYTEA,
    "test_secret_key_iv" BYTEA,
    "test_secret_key_tag" BYTEA,
    "test_secret_key_last_four" TEXT,
    "test_saved_at" TIMESTAMPTZ,
    "live_secret_key_ciphertext" BYTEA,
    "live_secret_key_iv" BYTEA,
    "live_secret_key_tag" BYTEA,
    "live_secret_key_last_four" TEXT,
    "live_saved_at" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "StripeOperatorCredential_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StripeCatalogAudit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "actor_operator_id" UUID,
    "actor_email" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "StripeCatalogAudit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StripeCatalogAudit_product_id_fkey"
        FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "StripeCatalogAudit_actor_operator_id_fkey"
        FOREIGN KEY ("actor_operator_id") REFERENCES "Operator"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "StripeCatalogAudit_product_id_idx" ON "StripeCatalogAudit"("product_id");
CREATE INDEX "StripeCatalogAudit_action_idx" ON "StripeCatalogAudit"("action");
CREATE INDEX "StripeCatalogAudit_created_at_idx" ON "StripeCatalogAudit"("created_at");
