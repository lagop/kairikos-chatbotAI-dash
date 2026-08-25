-- WP-XX (Fase 9) — the messaging engine's storage.
--
-- Two things: per-direction delivery state on CallEvent, and the
-- per-subscription blocklist. Both are additive; nothing existing changes
-- meaning, so this is safe to apply to a populated table.

-- ---------------------------------------------------------------------------
-- CallEvent: what happened to each of the two messages a call produces.
-- ---------------------------------------------------------------------------
ALTER TABLE "CallEvent"
    ADD COLUMN IF NOT EXISTS "caller_notify_channel"  TEXT,
    ADD COLUMN IF NOT EXISTS "caller_notify_error"    TEXT,
    ADD COLUMN IF NOT EXISTS "caller_notify_attempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "owner_notify_error"     TEXT,
    ADD COLUMN IF NOT EXISTS "owner_notify_attempts"  INTEGER NOT NULL DEFAULT 0;

-- The sweep asks "which calls still owe someone a message". The nullable
-- stamp leads the index because it is the selective column: every call
-- older than a few minutes is already notified, so the interesting rows
-- are always the NULL ones.
CREATE INDEX IF NOT EXISTS "CallEvent_notified_caller_at_started_at_idx"
    ON "CallEvent" ("notified_caller_at", "started_at");
CREATE INDEX IF NOT EXISTS "CallEvent_notified_owner_at_started_at_idx"
    ON "CallEvent" ("notified_owner_at", "started_at");

-- The 24h throttle: the most recent message this client sent to this
-- number. Without the index this is a scan on every single send.
CREATE INDEX IF NOT EXISTS "CallEvent_client_id_from_number_notified_caller_at_idx"
    ON "CallEvent" ("client_id", "from_number", "notified_caller_at");

-- ---------------------------------------------------------------------------
-- RecallBlockedNumber: numbers this client never wants messaged back.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "RecallBlockedNumber" (
    "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
    "client_id"       TEXT         NOT NULL,
    "subscription_id" UUID         NOT NULL,
    "e164"            TEXT         NOT NULL,
    "reason"          TEXT,
    "created_by"      TEXT,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecallBlockedNumber_pkey" PRIMARY KEY ("id")
);

-- One row per (subscription, number): blocking twice is the same block,
-- and the upsert the operator route performs depends on this.
CREATE UNIQUE INDEX IF NOT EXISTS "RecallBlockedNumber_subscription_id_e164_key"
    ON "RecallBlockedNumber" ("subscription_id", "e164");
CREATE INDEX IF NOT EXISTS "RecallBlockedNumber_client_id_idx"
    ON "RecallBlockedNumber" ("client_id");

ALTER TABLE "RecallBlockedNumber"
    ADD CONSTRAINT "RecallBlockedNumber_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RecallBlockedNumber"
    ADD CONSTRAINT "RecallBlockedNumber_subscription_id_fkey"
    FOREIGN KEY ("subscription_id") REFERENCES "RecallSubscription" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
