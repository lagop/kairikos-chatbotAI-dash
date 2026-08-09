-- Migration: KAIA-13281 — OperatorAction audit table + ChatbotClient.notes
--
-- Adds:
--   1. OperatorAction          — audit log of operator-driven edits to a
--                                ChatbotClient. One row per changed field,
--                                written transactionally with the
--                                ChatbotClient update inside
--                                PATCH /api/admin/portal/clients/[clientId].
--   2. ChatbotClient.notes     — nullable operator-editable free-form note.
--                                (No default — existing rows are not
--                                backfilled; the column is NULL until an
--                                operator explicitly writes one.)
--
-- Reversibility: see rollback.sql. Order is the inverse of the migration:
--   drop OperatorAction table + indexes first, then drop the
--   ChatbotClient.notes column. No other tables reference OperatorAction
--   (no FK from any other model), so the DROP is uncontested.
--
-- Domain lens: idempotent webhooks / migration safety — every change
-- here is additive (CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT NULL,
-- CREATE INDEX IF NOT EXISTS) so a re-run is a no-op against an
-- already-migrated DB.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- 1. OperatorAction
-- ============================================================================
-- One row per operator field-level edit. The PATCH route writes one of
-- these per changed field in the same transaction as the ChatbotClient
-- update, so the audit log and the live row cannot drift.
--
-- Append-only: the application layer only ever issues INSERT against this
-- table (mirrors ChatbotConfigStepAudit / OperatorSettingsAudit).
CREATE TABLE IF NOT EXISTS "OperatorAction" (
    "id"           TEXT         PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "client_id"    TEXT         NOT NULL,
    -- 'operator' (default). Free-form so future actor kinds can land
    -- without a migration.
    "actor_type"   TEXT         NOT NULL DEFAULT 'operator',
    -- Operator email or user id — set by the route from the session.
    "actor_id"     TEXT         NOT NULL,
    -- Field name that changed (route allowlist: companyName | email |
    -- tier | goLiveAt | state | notes).
    "field"        TEXT         NOT NULL,
    -- Stringified prior value. NULL when the column was previously NULL
    -- (e.g. notes was unset and remains unset → no audit row).
    "before_value" TEXT,
    -- Stringified new value. NULL when the column is being cleared.
    "after_value"  TEXT,
    "created_at"   TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT "OperatorAction_client_id_fkey"
        FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id")
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "OperatorAction_client_id_idx"
    ON "OperatorAction" ("client_id");

CREATE INDEX IF NOT EXISTS "OperatorAction_client_id_created_at_idx"
    ON "OperatorAction" ("client_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "OperatorAction_actor_id_idx"
    ON "OperatorAction" ("actor_id");

CREATE INDEX IF NOT EXISTS "OperatorAction_field_idx"
    ON "OperatorAction" ("field");

-- ============================================================================
-- 2. ChatbotClient.notes
-- ============================================================================
-- Nullable operator-editable free-form note. v1 has no length constraint;
-- the route caps writes at 4_000 chars at the application layer to keep
-- the audit table's before/after text reasonable.
ALTER TABLE "ChatbotClient"
    ADD COLUMN IF NOT EXISTS "notes" TEXT;