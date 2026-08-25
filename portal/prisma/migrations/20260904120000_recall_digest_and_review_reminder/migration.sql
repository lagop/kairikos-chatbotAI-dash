-- WP-XX (Fase 10) — the daily digest and the one review reminder.
--
-- Additive only: nothing existing changes meaning, so this is safe on a
-- populated database.

-- ---------------------------------------------------------------------------
-- ReviewRequest: the single follow-up a recipient ever gets.
--
-- One column, and it is the enforcement mechanism as much as the record:
-- with nowhere to store a second reminder, no future code path can send
-- one without a migration to justify itself first.
-- ---------------------------------------------------------------------------
ALTER TABLE "ReviewRequest"
    ADD COLUMN IF NOT EXISTS "reminded_at" TIMESTAMP(3);

-- Drives the reminder sweep: sent, never opened, never reminded.
CREATE INDEX IF NOT EXISTS "ReviewRequest_status_sent_at_reminded_at_idx"
    ON "ReviewRequest" ("status", "sent_at", "reminded_at");

-- ---------------------------------------------------------------------------
-- RecallDigest: the 19:00 summary and the owner's reply to it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "RecallDigest" (
    "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
    "client_id"       TEXT         NOT NULL,
    "subscription_id" UUID         NOT NULL,

    -- 'YYYY-MM-DD' in the subscription's own timezone, not a DATE: "the
    -- owner's Tuesday" is a wall-clock concept, and storing it as an
    -- instant would move the day boundary twice a year.
    "local_date"      TEXT         NOT NULL,

    -- Ordered. The number the owner sees is the index plus one, so the
    -- order must be persisted rather than recomputed — a later query
    -- returning a different order would silently remap his reply.
    "call_event_ids"  JSONB        NOT NULL,

    "sent_at"         TIMESTAMP(3),
    "send_error"      TEXT,
    "attempts"        INTEGER      NOT NULL DEFAULT 0,

    -- Verbatim. If the owner later disputes what he asked for, this is
    -- the answer.
    "raw_response"             TEXT,
    "selected_call_event_ids"  JSONB,
    "responded_at"             TIMESTAMP(3),
    "clarified_at"             TIMESTAMP(3),

    "campaign_id"     UUID,

    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecallDigest_pkey" PRIMARY KEY ("id")
);

-- The idempotency key. The tick runs every five minutes and must never
-- send the same summary twice.
CREATE UNIQUE INDEX IF NOT EXISTS "RecallDigest_subscription_id_local_date_key"
    ON "RecallDigest" ("subscription_id", "local_date");
CREATE INDEX IF NOT EXISTS "RecallDigest_client_id_idx"
    ON "RecallDigest" ("client_id");
-- Drives the reply router: is there a digest this owner could be
-- answering right now?
CREATE INDEX IF NOT EXISTS "RecallDigest_subscription_id_sent_at_idx"
    ON "RecallDigest" ("subscription_id", "sent_at");

ALTER TABLE "RecallDigest"
    ADD CONSTRAINT "RecallDigest_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RecallDigest"
    ADD CONSTRAINT "RecallDigest_subscription_id_fkey"
    FOREIGN KEY ("subscription_id") REFERENCES "RecallSubscription" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
