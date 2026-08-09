-- KAIA-13259 — Admin editor mode schema foundations (KAIA-13281).
--
-- Adds the `OperatorAction` audit table and a `notes` column on
-- `ChatbotClient`. The PATCH route at /api/admin/portal/clients/[id] writes
-- one operatorAction row per changed field in the same transaction as the
-- ChatbotClient update, so the audit log is always consistent with the
-- client row.
--
-- Idempotency / safety:
--   * CREATE TABLE IF NOT EXISTS — safe to re-run on a partially-applied
--     database.
--   * ALTER TABLE … ADD COLUMN IF NOT EXISTS — same.
--   * Indexes are wrapped in CREATE INDEX IF NOT EXISTS.
--   * The OnDelete: Cascade on OperatorAction.clientId guarantees the
--     audit trail is cleaned up with the client (no dangling rows).
--
-- Rollback (rollback.sql):
--   * DROP TABLE "OperatorAction" (also drops the indexes)
--   * ALTER TABLE "ChatbotClient" DROP COLUMN "notes"
-- The rollback is safe: OperatorAction has no inbound FKs.

-- ── OperatorAction ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "OperatorAction" (
    "id"          TEXT         NOT NULL,
    "client_id"   TEXT         NOT NULL,
    "actor_type"  TEXT         NOT NULL DEFAULT 'operator',
    "actor_id"    TEXT         NOT NULL,
    "field"       TEXT         NOT NULL,
    "before_value" TEXT,
    "after_value"  TEXT,
    "created_at"  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT "OperatorAction_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'OperatorAction_client_id_fkey'
    ) THEN
        ALTER TABLE "OperatorAction"
            ADD CONSTRAINT "OperatorAction_client_id_fkey"
            FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END$$;

CREATE INDEX IF NOT EXISTS "OperatorAction_client_id_idx"
    ON "OperatorAction" ("client_id");
CREATE INDEX IF NOT EXISTS "OperatorAction_client_id_created_at_idx"
    ON "OperatorAction" ("client_id", "created_at");
CREATE INDEX IF NOT EXISTS "OperatorAction_actor_id_idx"
    ON "OperatorAction" ("actor_id");

-- ── ChatbotClient.notes ─────────────────────────────────────────────────

ALTER TABLE "ChatbotClient" ADD COLUMN IF NOT EXISTS "notes" TEXT;
