-- Migration: IntakeSubmission table (KAIA-2913)
--
-- In-housing the chatbot intake form on the portal. The public endpoint
-- POST /api/public/intake writes one row per accepted submission. Replaces
-- the Tally webhook that previously drove the operator + n8n pipeline.
--
-- Idempotency: each submission carries a client-supplied `idempotency_key`
-- (header X-Idempotency-Key) so the route can short-circuit on retries
-- without creating duplicate IntakeSubmission / ChatbotClientUser rows.
-- The unique index on `idempotency_key` is the safety net even if the
-- application-level dedup check ever races.
--
-- Source channel: `source = 'public_intake'` for the in-house portal form.
-- Future channels (e.g. CSV imports, partner API) can write into the same
-- table with a different `source` value; `source` is free-form text.
--
-- Vertical: derived from `sector` in the route handler (see
-- deriveVertical in src/lib/intake-schema.ts). Stored as a denormalized
-- string so list/admin UIs don't have to re-walk the JSONB payload.
--
-- Optional FK: `client_id` is NULL until the ChatbotClientUser / ChatbotClient
-- rows are created in the same transaction. The route updates it once those
-- rows are committed so the operator can join IntakeSubmission → ChatbotClient
-- for follow-up without going through the email index.

CREATE TABLE "IntakeSubmission" (
    "id"              TEXT        NOT NULL PRIMARY KEY DEFAULT cuid(),
    -- Idempotency key from the X-Idempotency-Key header (or generated server-side
    -- when the caller omits one). Sized for typical UUIDv4 (36 chars) and
    -- longer ULID/KSUID values callers might choose.
    "idempotency_key" TEXT        NOT NULL UNIQUE,
    -- 'public_intake' | future sources (csv_import, partner_api, ...). Free-form
    -- so the route layer can introduce new values without a schema migration.
    "source"          TEXT        NOT NULL,
    -- Vertical tag derived from `sector` (e.g. 'clinica-dental', 'restauracion').
    -- Indexed for the operator admin filter (KAIA-2913 / Fase 2 UI).
    "vertical"        TEXT        NOT NULL,
    -- Form spec slug — keeps the table multi-form-friendly in case the
    -- operator wants to add a second intake funnel later.
    "intake_slug"     TEXT        NOT NULL,
    -- Full payload as JSONB so the operator portal can re-render the
    -- submission without going back to Tally / losing history.
    "payload"         JSONB       NOT NULL,
    -- Set once the route resolves the submission to a ChatbotClient (i.e. the
    -- ChatbotClient / ChatbotClientUser rows committed). NULL during the brief
    -- window between IntakeSubmission insert and the subsequent client upsert.
    "client_id"       TEXT,
    -- Subset of fields used by the admin list / search views. Kept on the row
    -- so a list query doesn't have to extract from JSONB on every page load.
    "business_name"   TEXT        NOT NULL,
    "human_handoff_email" TEXT    NOT NULL,
    "ip_hash"         TEXT,
    "user_agent"      TEXT,
    "created_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "IntakeSubmission_client_id_fkey"
        FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id")
        ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "IntakeSubmission_created_at_idx"      ON "IntakeSubmission" ("created_at" DESC);
CREATE INDEX "IntakeSubmission_vertical_idx"        ON "IntakeSubmission" ("vertical");
CREATE INDEX "IntakeSubmission_source_idx"          ON "IntakeSubmission" ("source");
CREATE INDEX "IntakeSubmission_intake_slug_idx"     ON "IntakeSubmission" ("intake_slug");
CREATE INDEX "IntakeSubmission_business_name_idx"   ON "IntakeSubmission" ("business_name");
CREATE INDEX "IntakeSubmission_human_handoff_email_idx" ON "IntakeSubmission" ("human_handoff_email");
CREATE INDEX "IntakeSubmission_client_id_idx"       ON "IntakeSubmission" ("client_id");