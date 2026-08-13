-- Migration: WP-11 — SupportRequest table
--
-- Persists client "Necesito ayuda" submissions (POST /api/portal/operator,
-- kind: 'help-request') as first-class rows, one per submission.
--
-- Before this table, the request's subject/message only ever lived in
-- OperatorNotification.context — a JSON-as-string blob keyed by
-- (client_id, kind, day). That row is upserted for the daily EMAIL dedup,
-- which is correct behavior for the alert (the operator shouldn't get
-- spammed by repeat clicks), but it meant a second help request from the
-- same client on the same UTC day silently overwrote the first one's
-- context, and there was no admin view to browse past requests at all.
--
-- SupportRequest is independent of that dedup window: every accepted
-- request gets its own row, and the admin panel manages it via `status`
-- ('open' -> 'resolved'), not via the email send state.
--
-- Reversibility: see rollback.sql. Purely additive (CREATE TABLE IF NOT
-- EXISTS, CREATE INDEX IF NOT EXISTS) so a re-run against an
-- already-migrated DB is a no-op.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS "SupportRequest" (
    "id"                       TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "client_id"                TEXT        NOT NULL,
    -- KAIA-4258: tenant isolation FK. NULL for pre-multi-tenant rows.
    "tenant_id"                UUID,
    "subject"                  TEXT        NOT NULL,
    "message"                  TEXT        NOT NULL,
    -- 'open' | 'resolved'. Enforced server-side (route allowlist) — same
    -- convention as OperatorNotification.kind / ChatbotClient.state.
    "status"                   TEXT        NOT NULL DEFAULT 'open',
    -- Operator email/id who marked it resolved — free-form string, same
    -- convention as OperatorAction.actor_id (not a FK to Operator).
    "resolved_by_operator_id"  TEXT,
    "resolved_at"              TIMESTAMPTZ,
    "created_at"               TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at"               TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "SupportRequest_client_id_fkey"
        FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SupportRequest_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
        ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "SupportRequest_client_id_idx"
    ON "SupportRequest" ("client_id");

CREATE INDEX IF NOT EXISTS "SupportRequest_client_id_created_at_idx"
    ON "SupportRequest" ("client_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "SupportRequest_status_idx"
    ON "SupportRequest" ("status");

CREATE INDEX IF NOT EXISTS "SupportRequest_status_created_at_idx"
    ON "SupportRequest" ("status", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "SupportRequest_tenant_id_idx"
    ON "SupportRequest" ("tenant_id");
