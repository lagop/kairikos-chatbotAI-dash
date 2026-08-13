-- =============================================================================
-- WP-09 — candidate migration: close out the multi-tenant tenant_id rollout
-- for the "always client-scoped" tables (Group A — see 01-audit.sql).
--
-- NOT auto-applied. This file intentionally lives outside prisma/migrations/
-- so `prisma migrate deploy` never picks it up on its own. Before running
-- it against production:
--
--   1. Run 01-audit.sql against production and read the output. In
--      particular: confirm the "how many tenants exist" query returns
--      exactly one row (slug='default'). If it returns more than one,
--      STOP — do not run this file — and investigate per-tenant NULL
--      counts first (a blanket backfill to the default tenant would
--      silently misassign any client that belongs to a different tenant).
--   2. Confirm the app-code fix in this same WP-09 PR (portal/src/lib/tenant.ts
--      and its call sites) has been deployed for at least one full
--      release cycle, so you're not racing new NULL rows still landing
--      from an old running instance.
--   3. Take a DB snapshot/backup — this ships a real backfill; see
--      03-rollback.sql for the inverse, but backfilled values are not
--      un-backfilled by it.
--   4. Move this file (rename to a timestamp-prefixed directory) into
--      prisma/migrations/ and run `npm run prisma:migrate:deploy`, OR
--      run it directly with psql against DIRECT_URL. Either way it must
--      run against the DIRECT (non-pooled) connection — see the
--      datasource comment in prisma/schema.prisma re: KAIA-14409/KAIA-14440.
--
-- Scope: Group A only (ChatbotClient, ChatbotClientUser, ChatbotActivity,
-- ChatbotConversation, ChatbotConfigStep, ChatbotConfigStepAudit,
-- ClientProduct, ClientProductAudit). IntakeSubmission, OperatorNotification,
-- and N8nExecution (Group B) are deliberately NOT touched — they can
-- represent a true global/unassigned event with no client, so tenant_id
-- stays nullable for them.
--
-- NOTE — ChatbotConversation is written by an external pipeline (n8n /
-- Supabase sync), not this app. No portal code path creates these rows
-- (confirmed: no `chatbotConversation.create` call anywhere in
-- portal/src). Backfilling existing rows here is safe, but the NOT NULL
-- constraint added below will start rejecting that external pipeline's
-- inserts the moment it writes a row without tenant_id — coordinate with
-- whoever owns that pipeline BEFORE running this file, not after.
--
-- Idempotent: every step is IF NOT EXISTS / re-runnable. Self-healing:
-- the backfill runs before the NOT NULL constraint in the same
-- transaction, so even a table with straggler NULLs today is corrected
-- by this same file rather than needing 01-audit.sql's count to already
-- be zero — the audit is a sanity check on the DEFAULT_TENANT_ID
-- assumption, not a hard precondition for this file to succeed.
-- =============================================================================

BEGIN;

-- Must match DEFAULT_TENANT_ID in portal/src/lib/tenant.ts and the seed
-- value in 20260724130000_multi_tenant_phase0/migration.sql.
DO $$
DECLARE
    v_default_tenant_id UUID := '00000000-0000-0000-0000-000000000001';
BEGIN
    IF NOT EXISTS (SELECT 1 FROM "Tenant" WHERE id = v_default_tenant_id) THEN
        RAISE EXCEPTION 'Default tenant % not found — aborting', v_default_tenant_id;
    END IF;

    -- ---- 1. Backfill straggler NULLs -----------------------------------
    -- ChatbotClient has no parent to derive from — falls back straight to
    -- the default tenant, same policy the original Phase 0 backfill used.
    UPDATE "ChatbotClient" SET "tenant_id" = v_default_tenant_id WHERE "tenant_id" IS NULL;

    -- Everything else derives from its own ChatbotClient (now guaranteed
    -- non-null by the update above).
    UPDATE "ChatbotClientUser" ccu
    SET "tenant_id" = cc."tenant_id"
    FROM "ChatbotClient" cc
    WHERE ccu."clientId" = cc."id" AND ccu."tenant_id" IS NULL;

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

    UPDATE "ClientProduct" cp
    SET "tenant_id" = cc."tenant_id"
    FROM "ChatbotClient" cc
    WHERE cp."client_id" = cc."id" AND cp."tenant_id" IS NULL;

    UPDATE "ClientProductAudit" cpa
    SET "tenant_id" = cc."tenant_id"
    FROM "ChatbotClient" cc
    WHERE cpa."client_id" = cc."id" AND cpa."tenant_id" IS NULL;

    -- ---- 2. Hard safety net --------------------------------------------
    -- If anything is still NULL here, a row's client itself has no
    -- resolvable tenant (shouldn't happen after step 1) or a FK is
    -- pointing at a client_id that doesn't exist (orphan row). Abort
    -- rather than silently leaving a NOT NULL column with NULLs, which
    -- would make the ALTER COLUMN below fail anyway, but with a much
    -- less informative error.
    IF EXISTS (SELECT 1 FROM "ChatbotClient" WHERE "tenant_id" IS NULL)
        OR EXISTS (SELECT 1 FROM "ChatbotClientUser" WHERE "tenant_id" IS NULL)
        OR EXISTS (SELECT 1 FROM "ChatbotActivity" WHERE "tenant_id" IS NULL)
        OR EXISTS (SELECT 1 FROM "ChatbotConversation" WHERE "tenant_id" IS NULL)
        OR EXISTS (SELECT 1 FROM "ChatbotConfigStep" WHERE "tenant_id" IS NULL)
        OR EXISTS (SELECT 1 FROM "ChatbotConfigStepAudit" WHERE "tenant_id" IS NULL)
        OR EXISTS (SELECT 1 FROM "ClientProduct" WHERE "tenant_id" IS NULL)
        OR EXISTS (SELECT 1 FROM "ClientProductAudit" WHERE "tenant_id" IS NULL)
    THEN
        RAISE EXCEPTION 'WP-09: backfill left at least one Group A row with tenant_id IS NULL — likely an orphan FK (client_id/stepId pointing at a missing parent row). Investigate before re-running.';
    END IF;
END $$;

-- ---- 3. DB-level DEFAULT (defense in depth) --------------------------------
-- Belt-and-suspenders alongside the app-code fix (src/lib/tenant.ts): if a
-- future write path is ever added that forgets to pass tenantId, Postgres
-- fills it in rather than throwing a NOT NULL violation in production.
ALTER TABLE "ChatbotClient"          ALTER COLUMN "tenant_id" SET DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE "ChatbotClientUser"      ALTER COLUMN "tenant_id" SET DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE "ChatbotActivity"        ALTER COLUMN "tenant_id" SET DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE "ChatbotConversation"    ALTER COLUMN "tenant_id" SET DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE "ChatbotConfigStep"      ALTER COLUMN "tenant_id" SET DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE "ChatbotConfigStepAudit" ALTER COLUMN "tenant_id" SET DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE "ClientProduct"          ALTER COLUMN "tenant_id" SET DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE "ClientProductAudit"     ALTER COLUMN "tenant_id" SET DEFAULT '00000000-0000-0000-0000-000000000001';

-- ---- 4. NOT NULL ------------------------------------------------------------
ALTER TABLE "ChatbotClient"          ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "ChatbotClientUser"      ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "ChatbotActivity"        ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "ChatbotConversation"    ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "ChatbotConfigStep"      ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "ChatbotConfigStepAudit" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "ClientProduct"          ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "ClientProductAudit"     ALTER COLUMN "tenant_id" SET NOT NULL;

COMMIT;

-- ---- After this runs ---------------------------------------------------
-- Update portal/prisma/schema.prisma to drop the `?` on `tenantId` for the
-- eight Group A models above (and add `@default("00000000-0000-0000-0000-000000000001")`
-- to match step 3) in a small follow-up PR, THEN run `prisma generate` so
-- the client types stop claiming `tenantId: string | null` for columns
-- that are now genuinely NOT NULL. Do this AFTER confirming the migration
-- applied successfully — not in the same PR as this file — so
-- schema.prisma never claims a constraint that doesn't exist yet in any
-- real database.
