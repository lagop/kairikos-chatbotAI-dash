-- Migration: Multi-tenant Phase 0 schema (KAIA-4258)
--
-- Adds the tenant layer to the in-house portal database and backfills
-- the existing single-tenant data into a 'default' Tenant. This is the
-- counterpart to the Supabase migration
--   supabase/migrations/20260724_tenant_isolation_v1.up.sql
-- that the Frontend Developer shipped for the Supabase (auth.users-centric)
-- side of the same multi-tenant refactor. The two databases are kept
-- aligned for the same logical entities (tenants, profiles, products,
-- client_products) so the owner aggregation view sees one tenant per
-- row in both stores.
--
-- Pre-flight: ensure pgcrypto is available so gen_random_uuid() resolves
-- when the backfill inserts new ClientProduct rows (server-side UUID gen).
-- IF NOT EXISTS so re-running the migration is safe.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- What this migration does:
--   1. Creates four new tables: Tenant, Profile, Product, ClientProduct.
--   2. Adds NULLable tenant_id (UUID) FK to every existing chatbot-data
--      table that scopes its rows to a tenant.
--   3. Creates a default Tenant ('default' slug) and backfills
--      tenant_id on every existing row in those tables.
--   4. Creates indexes on tenant_id for the portal query plans that
--      filter by tenant (see KAIA-4267 — the API refactor child issue).
--   5. Creates the FK constraints with ON DELETE SET NULL so deleting
--      a Tenant does not cascade-drop client data (we soft-archive
--      instead — see rollback note).
--
-- Why nullable: the application layer only enforces tenant isolation
-- after the API refactor (KAIA-4267) lands. Until then, inserting a
-- new client without a tenant is allowed so existing routes continue
-- to work. The default-tenant backfill in step 3 covers all production
-- rows so the API refactor can flip the columns to NOT NULL after
-- the rollout.
--
-- Application-layer isolation (the portal's actual trust boundary):
-- the existing per-row isolation rule documented in prisma/README.md
-- still applies. The tenant_id column is a denormalization that lets
-- the API refactor replace the per-clientId scoping with one central
-- tenantId resolution from Profile. See KAIA-4267 for the routing
-- changes.
--
-- Reversibility: see the .rollback.sql companion. The rollback drops
-- the new tables and the new tenant_id columns. Backfilled values are
-- lost on rollback — capture a DB snapshot before applying this
-- migration in production.

-- =============================================================================
-- 1. Tenant
-- =============================================================================
CREATE TABLE IF NOT EXISTS "Tenant" (
    "id"         UUID        NOT NULL,
    "name"       TEXT        NOT NULL,
    "slug"       TEXT        NOT NULL UNIQUE,
    -- 'active' | 'suspended' | 'cancelled'. Enforced server-side.
    "status"     TEXT        NOT NULL DEFAULT 'active',
    -- Per-tenant feature flags (JSONB). Used by the rollout flag helper
    -- (KAIA-4267) to gate Phase 0 features per tenant.
    "features"   JSONB       NOT NULL DEFAULT '{}'::jsonb,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Tenant_slug_idx"   ON "Tenant" ("slug");
CREATE INDEX IF NOT EXISTS "Tenant_status_idx" ON "Tenant" ("status");

-- KAIA-14440: production drift reconciliation.
-- A parallel snake_case `tenants` registry was created out-of-band (Supabase
-- side) and `ChatbotClient.tenant_id` was already populated with ids that
-- reference `tenants`, NOT this `Tenant` table. Adding the FK below without
-- reconciling first fails with:
--   insert or update on table "ChatbotClient" violates foreign key constraint
--   Key (tenant_id)=(a3fb7a1c-…) is not present in table "Tenant".
-- Mirror every existing `tenants` row into `Tenant` (same ids) so the FK
-- resolves and no existing tenant assignment is rewritten or lost. Purely
-- additive: no row in `tenants` is modified or deleted.
--
-- Order matters: mirror `tenants` FIRST, then seed the fallback default only
-- if no 'default' slug arrived from the mirror. Production already has
-- slug='default' at a different id (a3fb7a1c-…), so seeding the hardcoded
-- 00000000-…-0001 first would take the slug and make the mirror's ON CONFLICT
-- ("id") DO NOTHING silently skip the real default tenant, leaving 65
-- ChatbotClient rows orphaned against the FK.
DO $do$ BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'tenants'
    ) THEN
        INSERT INTO "Tenant" ("id", "name", "slug", "status", "features", "created_at", "updated_at")
        SELECT t."id", t."name", t."slug", t."status", t."features", t."created_at", t."updated_at"
        FROM "tenants" t
        ON CONFLICT ("id") DO NOTHING;
    END IF;
END $do$;

-- Fallback default tenant for a virgin database (no `tenants` registry).
-- Idempotent: skipped when a 'default' slug already exists.
INSERT INTO "Tenant" ("id", "name", "slug", "status")
VALUES ('00000000-0000-0000-0000-000000000001', 'Default Tenant', 'default', 'active')
ON CONFLICT ("slug") DO NOTHING;

-- =============================================================================
-- 2. Profile (1:1 with User)
-- =============================================================================
CREATE TABLE IF NOT EXISTS "Profile" (
    "id"         TEXT        NOT NULL,
    -- FK to User — 1:1. UNIQUE so the canonical identity row is unambiguous.
    "user_id"    TEXT        NOT NULL UNIQUE,
    "tenant_id"  UUID        NOT NULL,
    -- 'owner' | 'admin' | 'viewer'. Enforced server-side.
    "role"       TEXT        NOT NULL DEFAULT 'viewer',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "Profile_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Profile_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "User"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Profile_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "Profile_tenant_id_idx" ON "Profile" ("tenant_id");
CREATE INDEX IF NOT EXISTS "Profile_role_idx"      ON "Profile" ("role");

-- =============================================================================
-- 3. Product (service tiers)
-- =============================================================================
CREATE TABLE IF NOT EXISTS "Product" (
    "id"              UUID        NOT NULL,
    -- Stripe price id (populated by the Stripe webhook handler in
    -- kira-studio-billing-backend). NULL for unsynced or grandfathered rows.
    "stripe_price_id" TEXT        UNIQUE,
    "name"            TEXT        NOT NULL,
    -- 'starter' | 'pro' | 'premium'. UNIQUE — one row per tier.
    "tier"            TEXT        NOT NULL UNIQUE,
    "price_cents"     INTEGER     NOT NULL,
    "currency"        TEXT        NOT NULL DEFAULT 'EUR',
    "features"        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    "is_active"       BOOLEAN     NOT NULL DEFAULT TRUE,
    "created_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Product_tier_idx"      ON "Product" ("tier");
CREATE INDEX IF NOT EXISTS "Product_is_active_idx" ON "Product" ("is_active") WHERE "is_active" = TRUE;

-- Seed the three tiers (idempotent — Stripe webhook will overwrite stripe_price_id).
INSERT INTO "Product" ("id", "stripe_price_id", "name", "tier", "price_cents", "features")
VALUES
    ('00000000-0000-0000-0000-000000000010', 'price_starter', 'Starter', 'starter', 9900,
     '{"max_conversations": 100, "max_users": 5, "support": "email"}'::jsonb),
    ('00000000-0000-0000-0000-000000000020', 'price_pro',     'Pro',     'pro',     24900,
     '{"max_conversations": 1000, "max_users": 20, "support": "priority"}'::jsonb),
    ('00000000-0000-0000-0000-000000000030', 'price_premium', 'Premium', 'premium', 49900,
     '{"max_conversations": -1, "max_users": -1, "support": "dedicated"}'::jsonb)
ON CONFLICT ("tier") DO UPDATE SET
    "stripe_price_id" = EXCLUDED."stripe_price_id",
    "name"            = EXCLUDED."name",
    "price_cents"     = EXCLUDED."price_cents",
    "features"        = EXCLUDED."features";

-- =============================================================================
-- 4. ClientProduct (chatbot_clients <-> products many-to-many)
-- =============================================================================
CREATE TABLE IF NOT EXISTS "ClientProduct" (
    "id"            UUID        NOT NULL,
    "client_id"     TEXT        NOT NULL,
    "product_id"    UUID        NOT NULL,
    "tenant_id"     UUID,
    -- 'active' | 'cancelled' | 'past_due'. Enforced server-side.
    "status"        TEXT        NOT NULL DEFAULT 'active',
    "subscribed_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "cancelled_at"  TIMESTAMPTZ,

    CONSTRAINT "ClientProduct_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ClientProduct_client_id_fkey"
        FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClientProduct_product_id_fkey"
        FOREIGN KEY ("product_id") REFERENCES "Product"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ClientProduct_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
        ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ClientProduct_client_id_product_id_key"
        UNIQUE ("client_id", "product_id")
);

CREATE INDEX IF NOT EXISTS "ClientProduct_client_id_idx"  ON "ClientProduct" ("client_id");
CREATE INDEX IF NOT EXISTS "ClientProduct_product_id_idx" ON "ClientProduct" ("product_id");
CREATE INDEX IF NOT EXISTS "ClientProduct_tenant_id_idx"  ON "ClientProduct" ("tenant_id");
CREATE INDEX IF NOT EXISTS "ClientProduct_status_idx"     ON "ClientProduct" ("status") WHERE "status" = 'active';

-- =============================================================================
-- 5. Add tenant_id to existing chatbot tables
-- =============================================================================
-- tenant_id is NULLable for now so the migration is safe to apply against
-- a live database without breaking existing routes that don't know about
-- tenants. The application-layer backfill in step 6 covers every existing
-- row. The API refactor (KAIA-4267) will flip the columns to NOT NULL
-- after the rollout completes.

-- 5.1 ChatbotClient
ALTER TABLE "ChatbotClient"
    ADD COLUMN IF NOT EXISTS "tenant_id" UUID;

DO $do$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChatbotClient_tenant_id_fkey') THEN
        ALTER TABLE "ChatbotClient"
            ADD CONSTRAINT "ChatbotClient_tenant_id_fkey"
            FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $do$;

CREATE INDEX IF NOT EXISTS "ChatbotClient_tenant_id_idx" ON "ChatbotClient" ("tenant_id");

-- 5.2 ChatbotClientUser
ALTER TABLE "ChatbotClientUser"
    ADD COLUMN IF NOT EXISTS "tenant_id" UUID;

DO $do$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChatbotClientUser_tenant_id_fkey') THEN
        ALTER TABLE "ChatbotClientUser"
            ADD CONSTRAINT "ChatbotClientUser_tenant_id_fkey"
            FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $do$;

CREATE INDEX IF NOT EXISTS "ChatbotClientUser_tenant_id_idx" ON "ChatbotClientUser" ("tenant_id");

-- 5.3 ChatbotActivity
ALTER TABLE "ChatbotActivity"
    ADD COLUMN IF NOT EXISTS "tenant_id" UUID;

DO $do$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChatbotActivity_tenant_id_fkey') THEN
        ALTER TABLE "ChatbotActivity"
            ADD CONSTRAINT "ChatbotActivity_tenant_id_fkey"
            FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $do$;

CREATE INDEX IF NOT EXISTS "ChatbotActivity_tenant_id_idx" ON "ChatbotActivity" ("tenant_id");

-- 5.4 ChatbotConversation
ALTER TABLE "ChatbotConversation"
    ADD COLUMN IF NOT EXISTS "tenant_id" UUID;

DO $do$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChatbotConversation_tenant_id_fkey') THEN
        ALTER TABLE "ChatbotConversation"
            ADD CONSTRAINT "ChatbotConversation_tenant_id_fkey"
            FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $do$;

CREATE INDEX IF NOT EXISTS "ChatbotConversation_tenant_id_idx" ON "ChatbotConversation" ("tenant_id");

-- 5.5 ChatbotConfigStep
ALTER TABLE "ChatbotConfigStep"
    ADD COLUMN IF NOT EXISTS "tenant_id" UUID;

DO $do$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChatbotConfigStep_tenant_id_fkey') THEN
        ALTER TABLE "ChatbotConfigStep"
            ADD CONSTRAINT "ChatbotConfigStep_tenant_id_fkey"
            FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $do$;

CREATE INDEX IF NOT EXISTS "ChatbotConfigStep_tenant_id_idx" ON "ChatbotConfigStep" ("tenant_id");

-- 5.6 ChatbotConfigStepAudit
ALTER TABLE "ChatbotConfigStepAudit"
    ADD COLUMN IF NOT EXISTS "tenant_id" UUID;

DO $do$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChatbotConfigStepAudit_tenant_id_fkey') THEN
        ALTER TABLE "ChatbotConfigStepAudit"
            ADD CONSTRAINT "ChatbotConfigStepAudit_tenant_id_fkey"
            FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $do$;

CREATE INDEX IF NOT EXISTS "ChatbotConfigStepAudit_tenant_id_idx" ON "ChatbotConfigStepAudit" ("tenant_id");

-- 5.7 IntakeSubmission
ALTER TABLE "IntakeSubmission"
    ADD COLUMN IF NOT EXISTS "tenant_id" UUID;

DO $do$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'IntakeSubmission_tenant_id_fkey') THEN
        ALTER TABLE "IntakeSubmission"
            ADD CONSTRAINT "IntakeSubmission_tenant_id_fkey"
            FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $do$;

CREATE INDEX IF NOT EXISTS "IntakeSubmission_tenant_id_idx" ON "IntakeSubmission" ("tenant_id");

-- 5.8 OperatorNotification
ALTER TABLE "OperatorNotification"
    ADD COLUMN IF NOT EXISTS "tenant_id" UUID;

DO $do$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OperatorNotification_tenant_id_fkey') THEN
        ALTER TABLE "OperatorNotification"
            ADD CONSTRAINT "OperatorNotification_tenant_id_fkey"
            FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $do$;

CREATE INDEX IF NOT EXISTS "OperatorNotification_tenant_id_idx" ON "OperatorNotification" ("tenant_id");

-- 5.9 N8nExecution
ALTER TABLE "N8nExecution"
    ADD COLUMN IF NOT EXISTS "tenant_id" UUID;

DO $do$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'N8nExecution_tenant_id_fkey') THEN
        ALTER TABLE "N8nExecution"
            ADD CONSTRAINT "N8nExecution_tenant_id_fkey"
            FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $do$;

CREATE INDEX IF NOT EXISTS "N8nExecution_tenant_id_idx" ON "N8nExecution" ("tenant_id");

-- =============================================================================
-- 6. Backfill tenant_id on every existing row
-- =============================================================================
-- Resolves the default tenant once and stitches it onto every existing row
-- in the chatbot-data tables. Runs as a single transaction so the
-- relationship invariants hold: ChatbotActivity.tenantId, ChatbotConversation.tenantId,
-- ChatbotConfigStep.tenantId, ChatbotConfigStepAudit.tenantId, ClientProduct.tenantId
-- are derived from ChatbotClient.tenantId, which is derived from the default.
-- ChatbotClientUser.tenantId is derived from the linked Profile when one
-- exists; otherwise from ChatbotClient.tenantId. IntakeSubmission,
-- OperatorNotification, and N8nExecution get the default tenant_id when
-- they have a non-null client_id; otherwise NULL (kept as NULL for true
-- global events).
DO $$
DECLARE
    v_default_tenant_id UUID;
BEGIN
    SELECT "id" INTO v_default_tenant_id
    FROM "Tenant"
    WHERE "slug" = 'default'
    LIMIT 1;

    IF v_default_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Default tenant missing — cannot backfill tenant_id';
    END IF;

    -- ChatbotClient — every existing row goes to the default tenant.
    UPDATE "ChatbotClient" SET "tenant_id" = v_default_tenant_id WHERE "tenant_id" IS NULL;

    -- ChatbotActivity / Conversation / ConfigStep — denormalized from
    -- ChatbotClient.tenant_id.
    UPDATE "ChatbotActivity" ca
    SET "tenant_id" = cc."tenant_id"
    FROM "ChatbotClient" cc
    WHERE ca."clientId" = cc."id" AND ca."tenant_id" IS NULL;

    UPDATE "ChatbotConversation" ccv
    SET "tenant_id" = cc."tenant_id"
    FROM "ChatbotClient" cc
    WHERE ccv."clientId" = cc."id" AND ccv."tenant_id" IS NULL;

    UPDATE "ChatbotConfigStep" ccs
    SET "tenant_id" = cc."tenant_id"
    FROM "ChatbotClient" cc
    WHERE ccs."clientId" = cc."id" AND ccs."tenant_id" IS NULL;

    UPDATE "ChatbotConfigStepAudit" ccsa
    SET "tenant_id" = ccs."tenant_id"
    FROM "ChatbotConfigStep" ccs
    WHERE ccsa."stepId" = ccs."id" AND ccsa."tenant_id" IS NULL;

    -- ChatbotClientUser — resolve through Profile when a Profile exists
    -- (Phase 1 will populate Profile for every User via the credentials
    -- signup flow). Until then, fall back to ChatbotClient.tenant_id.
    UPDATE "ChatbotClientUser" ccu
    SET "tenant_id" = COALESCE(
        (SELECT p."tenant_id" FROM "Profile" p WHERE p."user_id" = ccu."userId" LIMIT 1),
        (SELECT cc."tenant_id" FROM "ChatbotClient" cc WHERE cc."id" = ccu."clientId" LIMIT 1)
    )
    WHERE ccu."tenant_id" IS NULL;

    -- IntakeSubmission / OperatorNotification / N8nExecution — default
    -- tenant when there's a client, otherwise NULL (true global events
    -- like a global n8n failure).
    UPDATE "IntakeSubmission" i
    SET "tenant_id" = cc."tenant_id"
    FROM "ChatbotClient" cc
    WHERE i."client_id" = cc."id" AND i."tenant_id" IS NULL;

    UPDATE "OperatorNotification" o
    SET "tenant_id" = cc."tenant_id"
    FROM "ChatbotClient" cc
    WHERE o."clientId" = cc."id" AND o."tenant_id" IS NULL;

    UPDATE "N8nExecution" n
    SET "tenant_id" = cc."tenant_id"
    FROM "ChatbotClient" cc
    WHERE n."clientId" = cc."id" AND n."tenant_id" IS NULL;

    -- ClientProduct — for each existing ChatbotClient, seed a row linking
    -- it to the Product that matches the client's current `tier` column
    -- (Starter | Pro | Premium). This is the v1 single-product backfill
    -- so the existing client shows up in the new product/feature shape.
    INSERT INTO "ClientProduct" ("id", "client_id", "product_id", "tenant_id", "status", "subscribed_at")
    SELECT
        gen_random_uuid(),
        cc."id",
        p."id",
        cc."tenant_id",
        'active',
        NOW()
    FROM "ChatbotClient" cc
    JOIN "Product" p ON p."tier" = LOWER(cc."tier")
    WHERE cc."tenant_id" IS NOT NULL
    ON CONFLICT ("client_id", "product_id") DO NOTHING;
END $$;
