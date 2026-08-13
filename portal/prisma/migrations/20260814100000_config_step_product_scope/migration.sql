-- Migration: WP-13 — los pasos de configuración se scopean por producto
--
-- ChatbotConfigStep is identified by (clientId, stepKey, version) with a
-- partial UNIQUE index on (clientId, stepKey) WHERE activeForBot — both
-- assume every client has exactly ONE wizard. With five products (WP-12),
-- "Paso 1" of the chatbot wizard and "Paso 1" of the web wizard would
-- collide: creating the web wizard's first step would violate the version
-- unique key, and approving it would fight the chatbot's step for the one
-- allowed active row.
--
-- Depends on WP-12 (20260814090000_product_multi_service) — productCode
-- values are expected to match Product.code, though this migration does
-- not add an FK (ChatbotConfigStep.productCode stays a free-form string,
-- same convention as OperatorNotification.kind — enforced server-side,
-- not by a DB constraint, so a sixth product never needs a migration).
--
-- The DEFAULT 'chatbot' makes the backfill implicit (no UPDATE pass
-- needed — PostgreSQL 11+ doesn't rewrite the table for a DEFAULT-only
-- ADD COLUMN) and is kept permanently: any write that forgets to pass
-- productCode still lands on the correct product instead of failing.
--
-- Reversibility: see rollback.sql. Reverting is only safe if no client
-- has two products' steps sharing the same stepKey yet — see the check
-- query in rollback.sql.
--
-- Lock note: DROP INDEX + CREATE UNIQUE INDEX takes an exclusive lock.
-- On the current table size this is instantaneous; if this table has
-- grown by the time this runs in production, redo the two index swaps
-- below with CONCURRENTLY as a manual step outside this transaction —
-- CONCURRENTLY cannot run inside a Prisma migration transaction.

ALTER TABLE "ChatbotConfigStep"
    ADD COLUMN IF NOT EXISTS "productCode" TEXT NOT NULL DEFAULT 'chatbot';

-- ---- (clientId, stepKey, version) -> (clientId, productCode, stepKey, version) ----
DO $do$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChatbotConfigStep_clientId_stepKey_version_key') THEN
        DROP INDEX "ChatbotConfigStep_clientId_stepKey_version_key";
    ELSIF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'ChatbotConfigStep_clientId_stepKey_version_key') THEN
        DROP INDEX "ChatbotConfigStep_clientId_stepKey_version_key";
    END IF;
END $do$;

CREATE UNIQUE INDEX IF NOT EXISTS "ChatbotConfigStep_client_product_step_version_key"
    ON "ChatbotConfigStep" ("clientId", "productCode", "stepKey", "version");

-- ---- partial "at most one active row" index: same repoint ----
DROP INDEX IF EXISTS "ChatbotConfigStep_activeForBot_partial_uniq";
CREATE UNIQUE INDEX IF NOT EXISTS "ChatbotConfigStep_activeForBot_partial_uniq"
    ON "ChatbotConfigStep" ("clientId", "productCode", "stepKey")
    WHERE "activeForBot" = true;

-- ---- new planning-hint index for the common "steps of this product" query ----
CREATE INDEX IF NOT EXISTS "ChatbotConfigStep_client_product_step_idx"
    ON "ChatbotConfigStep" ("clientId", "productCode", "stepKey");
