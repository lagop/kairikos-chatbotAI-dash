-- Migration: WP-14 — hitos de onboarding y estado de ciclo de vida por producto
--
-- Two problems, one root cause: both ChatbotActivity and ChatbotClient.state
-- assumed a client has exactly one wizard/product. ChatbotActivity's unique
-- key is (clientId, milestone) — a client can't have a "T+0" for chatbot
-- AND a separate "T+0" for web. ChatbotClient.state is one column for the
-- whole client, when a client can have chatbot live and web still in
-- configuration at the same time.
--
--   1. ChatbotActivity gets `productCode` (DEFAULT 'chatbot', same
--      implicit-backfill idiom as WP-13's ChatbotConfigStep.productCode);
--      the unique key repoints to (clientId, productCode, milestone).
--   2. ClientProduct gets `onboarding_state` + `go_live_at` — this becomes
--      the source of truth for per-product lifecycle. ChatbotClient.state
--      is NOT removed: n8n listens for the transition to 'ready' on that
--      column to fire config_complete, and POST
--      /api/internal/clients/[id]/state-transition (KAIA-3127, Paperclip's
--      Day-2 endpoint) writes it directly with its own vocabulary
--      (paused/archived/draft). Both keep writing ChatbotClient.state as a
--      mirror of the chatbot product's onboarding_state — see the
--      application-code changes in this same PR (wizard-review.ts,
--      onboarding-actions.ts, the admin PATCH route, and the
--      state-transition route all now write both).
--
-- WP-14 FINDING beyond the plan's own migration sketch: not every
-- ChatbotClient has a ClientProduct row for 'chatbot'. The Phase 0
-- migration (20260724130000_multi_tenant_phase0) backfilled one for every
-- client that existed AT THAT TIME, matched by tier — but no write path
-- has created a ClientProduct row for a NEW client since (POST
-- /api/public/intake creates the ChatbotClient but never a ClientProduct;
-- fixed in the same PR as this migration). Step 4 below backfills the
-- missing rows before step 5 backfills their onboarding_state/go_live_at,
-- so this migration is self-sufficient rather than assuming step 4 was
-- unnecessary. A client whose `tier` doesn't match any 'chatbot' Product
-- row (data drift) is silently skipped here, same as the original Phase 0
-- backfill's own behavior — not a new failure mode this migration
-- introduces.
--
-- Reversibility: see rollback.sql. The ClientProduct backfill (new rows
-- from step 4) is NOT undone by the rollback — a rollback that deleted
-- ClientProduct rows could delete rows a human created in between via the
-- admin assign-product UI, which this migration has no way to tell apart
-- from its own backfill. The rollback only removes the two new columns.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- 1. ChatbotActivity.productCode
-- ============================================================================
ALTER TABLE "ChatbotActivity" ADD COLUMN IF NOT EXISTS "productCode" TEXT NOT NULL DEFAULT 'chatbot';

ALTER TABLE "ChatbotActivity" DROP CONSTRAINT IF EXISTS "ChatbotActivity_clientId_milestone_key";
CREATE UNIQUE INDEX IF NOT EXISTS "ChatbotActivity_client_product_milestone_key"
    ON "ChatbotActivity" ("clientId", "productCode", "milestone");
CREATE INDEX IF NOT EXISTS "ChatbotActivity_clientId_productCode_idx"
    ON "ChatbotActivity" ("clientId", "productCode");

-- ============================================================================
-- 2. ClientProduct.onboarding_state / go_live_at
-- ============================================================================
ALTER TABLE "ClientProduct"
    ADD COLUMN IF NOT EXISTS "onboarding_state" TEXT NOT NULL DEFAULT 'in-progress',
    ADD COLUMN IF NOT EXISTS "go_live_at" TIMESTAMPTZ;

-- ============================================================================
-- 3. Backfill
-- ============================================================================
DO $do$
BEGIN
    -- 3a. Create the missing 'chatbot' ClientProduct row for any client
    -- that doesn't have one yet (see the WP-14 FINDING note above).
    INSERT INTO "ClientProduct"
        ("id", "client_id", "product_id", "tenant_id", "status", "onboarding_state", "go_live_at", "subscribed_at", "changed_at")
    SELECT
        gen_random_uuid(),
        cc."id",
        p."id",
        cc."tenant_id",
        'active',
        cc."state",
        cc."goLiveAt",
        cc."createdAt",
        NOW()
    FROM "ChatbotClient" cc
    JOIN "Product" p ON p."code" = 'chatbot' AND p."tier" = LOWER(cc."tier")
    WHERE NOT EXISTS (
        SELECT 1 FROM "ClientProduct" cp2
        WHERE cp2."client_id" = cc."id" AND cp2."product_id" = p."id"
    )
    ON CONFLICT ("client_id", "product_id") DO NOTHING;

    -- 3b. Every 'chatbot' ClientProduct row (pre-existing or just inserted
    -- above) inherits its onboarding_state/go_live_at from ChatbotClient —
    -- the column ChatbotClient.state has always lived on, until now.
    UPDATE "ClientProduct" cp
    SET "onboarding_state" = cc."state",
        "go_live_at" = cc."goLiveAt"
    FROM "ChatbotClient" cc, "Product" p
    WHERE cp."client_id" = cc."id"
      AND cp."product_id" = p."id"
      AND p."code" = 'chatbot';
END $do$;
