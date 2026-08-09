-- Rollback: KAIA-4262 — Billing con Stripe (suscripción por producto)
--
-- Drops the four new objects in dependency order. Stripe event rows are
-- archived BEFORE the drop only if an audit copy is required; by default
-- the rows go away with the table.
--
-- Pre-conditions before running this:
--   1. The Stripe webhook handler /api/stripe/webhook is paused (no new
--      events written) OR the route has been removed from the deploy.
--   2. The portal billing routes (/api/portal/billing,
--      /api/admin/portal/billing/overview) have been removed from the
--      deploy so no read-side code path still references the dropped
--      tables.
--   3. Owner billing UI does NOT query Subscription/Invoice directly.

-- Drop order: child tables first, then the Tenant column, then the
-- idempotency log (no FKs in, so last but safe anywhere).

DROP TRIGGER IF EXISTS "Invoice_set_updated_at" ON "Invoice";
DROP INDEX IF EXISTS "Invoice_status_idx";
DROP INDEX IF EXISTS "Invoice_subscription_id_idx";
DROP INDEX IF EXISTS "Invoice_client_id_idx";
DROP INDEX IF EXISTS "Invoice_tenant_id_idx";
DROP TABLE IF EXISTS "Invoice";

DROP TRIGGER IF EXISTS "Subscription_set_updated_at" ON "Subscription";
DROP INDEX IF EXISTS "Subscription_stripe_customer_id_idx";
DROP INDEX IF EXISTS "Subscription_status_idx";
DROP INDEX IF EXISTS "Subscription_client_product_id_idx";
DROP INDEX IF EXISTS "Subscription_client_id_idx";
DROP INDEX IF EXISTS "Subscription_tenant_id_idx";
DROP TABLE IF EXISTS "Subscription";

DROP INDEX IF EXISTS "StripeWebhookEvent_received_at_idx";
DROP INDEX IF EXISTS "StripeWebhookEvent_status_idx";
DROP TABLE IF EXISTS "StripeWebhookEvent";

DROP INDEX IF EXISTS "Tenant_stripe_customer_id_key";
ALTER TABLE "Tenant" DROP COLUMN IF EXISTS "stripe_customer_id";
