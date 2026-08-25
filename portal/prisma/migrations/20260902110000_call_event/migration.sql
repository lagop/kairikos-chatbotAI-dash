-- WP-XX — Fase 3 de "Recuperación de llamadas perdidas + reseñas".
-- One row per call that reached a client's virtual number, i.e. per call
-- the client did not answer.
--
-- No audio column on purpose: Twilio hosts the recording and we delete it
-- there at 30 days. Keeping third-party voice in our own database would
-- turn a retention promise into a backup-retention problem.

CREATE TABLE "CallEvent" (
    "id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "subscription_id" UUID NOT NULL,
    "tenant_id" UUID,

    "twilio_call_sid" TEXT NOT NULL,

    "from_number" TEXT,
    "withheld" BOOLEAN NOT NULL DEFAULT false,
    "to_number" TEXT NOT NULL,
    "virtual_number_id" UUID,

    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),

    "recording_sid" TEXT,
    "recording_url" TEXT,
    "recording_duration_seconds" INTEGER,
    "recording_deleted_at" TIMESTAMP(3),

    "transcript" TEXT,
    "transcribed_at" TIMESTAMP(3),
    "transcription_error" TEXT,

    "outcome" TEXT NOT NULL DEFAULT 'pending',
    "lead_id" UUID,

    "notified_owner_at" TIMESTAMP(3),
    "notified_caller_at" TIMESTAMP(3),

    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallEvent_pkey" PRIMARY KEY ("id")
);

-- Idempotency keys: Twilio delivers webhooks at-least-once and retries on
-- any non-2xx, so both the call and the recording callback must be able
-- to find their existing row instead of creating a second one.
CREATE UNIQUE INDEX "CallEvent_twilio_call_sid_key" ON "CallEvent"("twilio_call_sid");
CREATE UNIQUE INDEX "CallEvent_recording_sid_key" ON "CallEvent"("recording_sid");

CREATE INDEX "CallEvent_client_id_started_at_idx" ON "CallEvent"("client_id", "started_at");
CREATE INDEX "CallEvent_subscription_id_started_at_idx" ON "CallEvent"("subscription_id", "started_at");
CREATE INDEX "CallEvent_outcome_idx" ON "CallEvent"("outcome");
CREATE INDEX "CallEvent_tenant_id_idx" ON "CallEvent"("tenant_id");
-- Drives the 30-day recording purge sweep.
CREATE INDEX "CallEvent_recording_deleted_at_started_at_idx" ON "CallEvent"("recording_deleted_at", "started_at");

ALTER TABLE "CallEvent"
    ADD CONSTRAINT "CallEvent_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CallEvent"
    ADD CONSTRAINT "CallEvent_subscription_id_fkey"
    FOREIGN KEY ("subscription_id") REFERENCES "RecallSubscription"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CallEvent"
    ADD CONSTRAINT "CallEvent_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CallEvent"
    ADD CONSTRAINT "CallEvent_virtual_number_id_fkey"
    FOREIGN KEY ("virtual_number_id") REFERENCES "VirtualNumber"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CallEvent"
    ADD CONSTRAINT "CallEvent_lead_id_fkey"
    FOREIGN KEY ("lead_id") REFERENCES "Lead"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
