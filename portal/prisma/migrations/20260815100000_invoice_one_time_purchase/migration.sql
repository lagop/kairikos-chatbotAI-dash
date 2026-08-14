-- Migration: WP-19 — facturación por producto (alta, cuota y pago único)
--
-- Invoice.subscription_id was NOT NULL — an Invoice could only exist
-- attached to a Subscription. That's correct for chatbot/leads/SEO
-- (recurring), but a one-time-purchase product (e.g. the web platform:
-- pago único, sin cuota) never creates a Subscription at all — WP-12's
-- Product.setupFeeCents/priceCents=0 shape already allows a product with
-- no recurring price, but nothing downstream could invoice it.
--
-- This migration:
--   1. Relaxes Invoice.subscription_id to nullable.
--   2. Adds Invoice.client_product_id (nullable) so a one-time-purchase
--      Invoice links straight to its ClientProduct instead.
--
-- Exactly one of subscription_id / client_product_id is set per row —
-- application code enforces this (see src/lib/stripe-billing.ts), no DB
-- CHECK constraint, matching this schema's existing convention of
-- documenting cross-field invariants in code rather than in SQL.
--
-- Reversibility: see rollback.sql. The rollback can only re-add NOT NULL
-- on subscription_id if every row already has one — i.e. only if no
-- one-time-purchase invoice has been created yet. That's the expected
-- state for any environment rolling back shortly after this migration;
-- the rollback script includes the pre-flight check as a comment.

ALTER TABLE "Invoice" ALTER COLUMN "subscription_id" DROP NOT NULL;

ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "client_product_id" UUID;

ALTER TABLE "Invoice"
    ADD CONSTRAINT "Invoice_client_product_id_fkey"
    FOREIGN KEY ("client_product_id") REFERENCES "ClientProduct"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "Invoice_client_product_id_idx" ON "Invoice"("client_product_id");
