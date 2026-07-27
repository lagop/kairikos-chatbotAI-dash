-- Migration: KAIA-4262 — Billing con Stripe (suscripción por producto)
--
-- Adds:
--   1. Tenant.stripe_customer_id   — link to Stripe Customer per tenant.
--   2. Subscription                — Stripe Subscription state mirror, 1:1
--                                     with ClientProduct.
--   3. Invoice                     — Stripe Invoice state mirror, N:1 with
--                                     Subscription.
--   4. StripeWebhookEvent          — idempotency table for the webhook
--                                     handler. PK = stripe event id.
--
-- Reversibility: see rollback.sql. The four new objects are dropped in
-- dependency order: invoices first (FKs in), then subscriptions, then the
-- new stripe_customer_id column on Tenant, then stripe_webhook_events.
-- Stripe event rows should be archived BEFORE rollback if a forensic
-- audit of past webhook deliveries is required.
--
-- Idempotency design (KAIA-4262 domain lens):
--   * stripe_webhook_events.event_id is PK. Any duplicate POST from
--     Stripe collapses to ON CONFLICT DO NOTHING. The handler checks
--     this row before mutating subscriptions/invoices.
--   * subscriptions.stripe_id is UNIQUE so the same Stripe Subscription
--     cannot be inserted twice even if the idempotency row is missing.
--   * invoices.stripe_id is UNIQUE for the same reason.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- 1. Tenant.stripe_customer_id
-- ============================================================================
-- Add a Stripe Customer link to each tenant. NULL until the owner (or
-- the portal onboarding wizard, when Fase 4 lands) creates the Stripe
-- Customer and the webhook stores the id back. We add it now so the
-- webhook handler can resolve tenant <-> customer without an extra
-- round-trip through auth.users.
ALTER TABLE "Tenant"
    ADD COLUMN IF NOT EXISTS "stripe_customer_id" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Tenant_stripe_customer_id_key"
    ON "Tenant" ("stripe_customer_id")
    WHERE "stripe_customer_id" IS NOT NULL;

-- ============================================================================
-- 2. Subscription
-- ============================================================================
-- One row per Stripe Subscription, scoped to exactly one ClientProduct.
-- The stripe_id UNIQUE constraint makes the upsert path in the webhook
-- idempotent even if the StripeWebhookEvent idempotency row is missing
-- (defence-in-depth).
CREATE TABLE IF NOT EXISTS "Subscription" (
    "id"                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id"           UUID         NOT NULL,
    "client_id"           TEXT         NOT NULL,
    "client_product_id"   UUID         NOT NULL,
    -- Stripe identifiers
    "stripe_id"           TEXT         NOT NULL,
    "stripe_customer_id"  TEXT         NOT NULL,
    "stripe_price_id"     TEXT,
    -- 'incomplete' | 'trialing' | 'active' | 'past_due' | 'canceled' |
    -- 'unpaid' | 'incomplete_expired' | 'paused'. Mirrors the Stripe
    -- subscription.status enum one-to-one so the portal UI can render
    -- the same states Stripe reports.
    "status"              TEXT         NOT NULL DEFAULT 'incomplete',
    "current_period_start" TIMESTAMPTZ,
    "current_period_end"   TIMESTAMPTZ,
    "cancel_at_period_end" BOOLEAN     NOT NULL DEFAULT FALSE,
    "canceled_at"          TIMESTAMPTZ,
    -- Currency minor units (matches Stripe convention, e.g. 9900 = 99€).
    "amount_cents"         INTEGER,
    "currency"             TEXT         NOT NULL DEFAULT 'eur',
    -- Raw snapshot of the latest Stripe subscription object for audit /
    -- debugging. NOT source of truth — fields above are. Truncated on
    -- rollback to keep audit row lean.
    "metadata"             JSONB        NOT NULL DEFAULT '{}'::jsonb,
    "created_at"           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    "updated_at"           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT "Subscription_client_product_id_fkey"
        FOREIGN KEY ("client_product_id")
        REFERENCES "ClientProduct"("id")
        ON DELETE CASCADE,
    CONSTRAINT "Subscription_client_id_fkey"
        FOREIGN KEY ("client_id")
        REFERENCES "ChatbotClient"("id")
        ON DELETE CASCADE,
    CONSTRAINT "Subscription_tenant_id_fkey"
        FOREIGN KEY ("tenant_id")
        REFERENCES "Tenant"("id")
        ON DELETE RESTRICT,
    CONSTRAINT "Subscription_stripe_id_key" UNIQUE ("stripe_id")
);

CREATE INDEX IF NOT EXISTS "Subscription_tenant_id_idx"
    ON "Subscription" ("tenant_id");
CREATE INDEX IF NOT EXISTS "Subscription_client_id_idx"
    ON "Subscription" ("client_id");
CREATE INDEX IF NOT EXISTS "Subscription_client_product_id_idx"
    ON "Subscription" ("client_product_id");
CREATE INDEX IF NOT EXISTS "Subscription_status_idx"
    ON "Subscription" ("status");
CREATE INDEX IF NOT EXISTS "Subscription_stripe_customer_id_idx"
    ON "Subscription" ("stripe_customer_id");

-- ============================================================================
-- 3. Invoice
-- ============================================================================
-- One row per Stripe Invoice. stripe_id UNIQUE so the webhook upsert is
-- idempotent. host_invoice_url is what the portal UI sends the user to
-- for the PDF (KAIA-4262 acceptance: "puede descargar la última PDF").
CREATE TABLE IF NOT EXISTS "Invoice" (
    "id"                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id"           UUID         NOT NULL,
    "client_id"           TEXT         NOT NULL,
    "subscription_id"     UUID         NOT NULL,
    -- Stripe identifiers
    "stripe_id"           TEXT         NOT NULL,
    -- 'draft' | 'open' | 'paid' | 'uncollectible' | 'void'. Mirrors Stripe.
    "status"              TEXT         NOT NULL DEFAULT 'draft',
    "number"              TEXT,
    "amount_due_cents"    INTEGER      NOT NULL DEFAULT 0,
    "amount_paid_cents"   INTEGER      NOT NULL DEFAULT 0,
    "currency"            TEXT         NOT NULL DEFAULT 'eur',
    "issued_at"           TIMESTAMPTZ,
    "due_at"              TIMESTAMPTZ,
    "paid_at"             TIMESTAMPTZ,
    "period_start"        TIMESTAMPTZ,
    "period_end"          TIMESTAMPTZ,
    "host_invoice_url"    TEXT,
    "invoice_pdf_url"     TEXT,
    "metadata"            JSONB        NOT NULL DEFAULT '{}'::jsonb,
    "created_at"          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    "updated_at"          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT "Invoice_subscription_id_fkey"
        FOREIGN KEY ("subscription_id")
        REFERENCES "Subscription"("id")
        ON DELETE CASCADE,
    CONSTRAINT "Invoice_client_id_fkey"
        FOREIGN KEY ("client_id")
        REFERENCES "ChatbotClient"("id")
        ON DELETE CASCADE,
    CONSTRAINT "Invoice_tenant_id_fkey"
        FOREIGN KEY ("tenant_id")
        REFERENCES "Tenant"("id")
        ON DELETE RESTRICT,
    CONSTRAINT "Invoice_stripe_id_key" UNIQUE ("stripe_id")
);

CREATE INDEX IF NOT EXISTS "Invoice_tenant_id_idx"
    ON "Invoice" ("tenant_id");
CREATE INDEX IF NOT EXISTS "Invoice_client_id_idx"
    ON "Invoice" ("client_id");
CREATE INDEX IF NOT EXISTS "Invoice_subscription_id_idx"
    ON "Invoice" ("subscription_id");
CREATE INDEX IF NOT EXISTS "Invoice_status_idx"
    ON "Invoice" ("status");

-- ============================================================================
-- 4. StripeWebhookEvent — idempotency log
-- ============================================================================
-- PK = stripe event id. Inserted before any state mutation. The handler
-- returns 200 OK and skips mutations if the row already exists.
-- payload_hash guards against the (rare) case where Stripe re-delivers
-- an event with the same id but mutated body — we still no-op.
CREATE TABLE IF NOT EXISTS "StripeWebhookEvent" (
    "event_id"      TEXT         PRIMARY KEY,
    "event_type"    TEXT         NOT NULL,
    "payload_hash"  TEXT         NOT NULL,
    "received_at"   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    "processed_at"  TIMESTAMPTZ,
    -- 'pending' | 'processed' | 'failed'. failed = handler threw; we still
    -- keep the row so retry deliveries short-circuit.
    "status"        TEXT         NOT NULL DEFAULT 'pending',
    "error_message" TEXT,
    -- 'subscription' | 'invoice' | 'ignored' — what the event mutated, if
    -- anything. Useful for the admin observability view.
    "applied_to"    TEXT,
    "stripe_api_version" TEXT
);

CREATE INDEX IF NOT EXISTS "StripeWebhookEvent_status_idx"
    ON "StripeWebhookEvent" ("status");
CREATE INDEX IF NOT EXISTS "StripeWebhookEvent_received_at_idx"
    ON "StripeWebhookEvent" ("received_at");

-- ============================================================================
-- 5. updated_at triggers
-- ============================================================================
-- Reuse the existing pattern from the multi-tenant migration so updated_at
-- is always bumped on row write.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at') THEN
        CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $func$
        BEGIN
            NEW.updated_at = NOW();
            RETURN NEW;
        END;
        $func$ LANGUAGE plpgsql;
    END IF;
END $$;

DROP TRIGGER IF EXISTS "Subscription_set_updated_at" ON "Subscription";
CREATE TRIGGER "Subscription_set_updated_at"
    BEFORE UPDATE ON "Subscription"
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS "Invoice_set_updated_at" ON "Invoice";
CREATE TRIGGER "Invoice_set_updated_at"
    BEFORE UPDATE ON "Invoice"
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
