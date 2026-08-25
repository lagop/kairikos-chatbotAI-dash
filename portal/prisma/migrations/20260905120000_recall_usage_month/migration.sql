-- WP-XX (Fase 11) — per-client monthly consumption.
--
-- Additive only. Every figure is derived from rows that already exist
-- (CallEvent, ReviewRequest), so this table can always be recomputed and
-- nothing new is written on the hot path.

CREATE TABLE IF NOT EXISTS "RecallUsageMonth" (
    "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
    "client_id"       TEXT         NOT NULL,
    "subscription_id" UUID         NOT NULL,

    -- 'YYYY-MM' in the subscription's own timezone. A month boundary is a
    -- calendar fact, not an interval of UTC.
    "local_month"     TEXT         NOT NULL,

    "calls"           INTEGER      NOT NULL DEFAULT 0,
    "recorded_calls"  INTEGER      NOT NULL DEFAULT 0,
    -- Survives the 30-day purge: that deletes the audio at Twilio and
    -- leaves the duration behind, so history stays measurable without
    -- keeping a single third-party voice.
    "call_seconds"    INTEGER      NOT NULL DEFAULT 0,

    "whatsapp_messages" INTEGER    NOT NULL DEFAULT 0,
    "sms_messages"      INTEGER    NOT NULL DEFAULT 0,
    "review_requests"   INTEGER    NOT NULL DEFAULT 0,

    -- Fires the operator alert once per month rather than on every tick.
    "alerted_at"      TIMESTAMP(3),
    "computed_at"     TIMESTAMP(3) NOT NULL,

    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecallUsageMonth_pkey" PRIMARY KEY ("id")
);

-- One rollup per client per month; the upsert key for the recompute job.
CREATE UNIQUE INDEX IF NOT EXISTS "RecallUsageMonth_subscription_id_local_month_key"
    ON "RecallUsageMonth" ("subscription_id", "local_month");
CREATE INDEX IF NOT EXISTS "RecallUsageMonth_client_id_idx"
    ON "RecallUsageMonth" ("client_id");
-- "Who is over budget this month" across every client at once — the whole
-- reason this is a rollup rather than a live aggregation.
CREATE INDEX IF NOT EXISTS "RecallUsageMonth_local_month_call_seconds_idx"
    ON "RecallUsageMonth" ("local_month", "call_seconds");

ALTER TABLE "RecallUsageMonth"
    ADD CONSTRAINT "RecallUsageMonth_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RecallUsageMonth"
    ADD CONSTRAINT "RecallUsageMonth_subscription_id_fkey"
    FOREIGN KEY ("subscription_id") REFERENCES "RecallSubscription" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
