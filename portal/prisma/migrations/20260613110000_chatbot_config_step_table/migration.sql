-- CreateTable: ChatbotConfigStep + ChatbotConfigStepAudit (KAIA-1163)
--
-- ChatbotConfigStep: one row per (client, stepKey, version). The wizard
-- creates version=1 on first save; subsequent edits increment version.
-- The bot always reads activeForBot=true for the given (clientId, stepKey).
-- The operator approves a version, flipping activeForBot to the new row.
--
-- Status lifecycle (enforced server-side, not via CHECK constraints):
--   draft → submitted → approved  (forward)
--         → needs_revision ←       (operator can flip back)
--
-- ChatbotConfigStepAudit: append-only audit log for every change to
-- ChatbotConfigStep. Enforced at the application layer — the wizard API
-- exposes only create, never update or delete on audit rows.
--
-- Rollback safety: neither table has production dependencies yet. Safe to
-- revert before the wizard v1 API endpoints (BE-2, BE-3) ship.

-- ── ChatbotConfigStep ──────────────────────────────────────────────────

CREATE TABLE "ChatbotConfigStep" (
    "id"                   TEXT         NOT NULL,
    "clientId"             TEXT         NOT NULL,
    -- Step identifier: "1" through "12". Enforced server-side by a per-step
    -- Zod schema registry in the route handler.
    "stepKey"              TEXT         NOT NULL,
    -- Monotonically increasing per (clientId, stepKey). Starts at 1.
    "version"              INTEGER      NOT NULL DEFAULT 1,
    -- 'draft' | 'submitted' | 'approved' | 'needs_revision'. Server-side only.
    "status"               TEXT         NOT NULL DEFAULT 'draft',
    -- Opaque JSON blob — form fields for this step. v1: plaintext JSON.
    -- v1.1: ciphertext + envelope metadata (forward-compatible JsonB).
    "payload"              JSONB,
    -- Set when the client clicks "Submit for review".
    "submittedAt"          TIMESTAMPTZ,
    -- Set when the operator approves this version.
    "approvedAt"           TIMESTAMPTZ,
    -- FK to Operator (UUID). NULL until approved.
    "approvedByOperatorId" UUID,
    -- Exactly one row per (clientId, stepKey) is active at any time.
    "activeForBot"         BOOLEAN      NOT NULL DEFAULT false,
    "createdAt"            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    "updatedAt"            TIMESTAMPTZ  NOT NULL,

    CONSTRAINT "ChatbotConfigStep_pkey" PRIMARY KEY ("id")
);

-- Unique per (client, step, version) — the natural business key.
CREATE UNIQUE INDEX "ChatbotConfigStep_clientId_stepKey_version_key"
    ON "ChatbotConfigStep" ("clientId", "stepKey", "version");

-- Fetch all versions of a step for a client (the common wizard query).
CREATE INDEX "ChatbotConfigStep_clientId_stepKey_idx"
    ON "ChatbotConfigStep" ("clientId", "stepKey");

-- Fast lookup for the bot's config loader: find the active row.
CREATE INDEX "ChatbotConfigStep_clientId_stepKey_activeForBot_idx"
    ON "ChatbotConfigStep" ("clientId", "stepKey", "activeForBot");

-- Dashboard filter: client steps by status (e.g. all submitted steps).
CREATE INDEX "ChatbotConfigStep_clientId_status_idx"
    ON "ChatbotConfigStep" ("clientId", "status");

-- FK: config steps cascade-deleted when the owning client is removed.
ALTER TABLE "ChatbotConfigStep"
    ADD CONSTRAINT "ChatbotConfigStep_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "ChatbotClient"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- FK: approvedBy references operator (set null on operator removal).
ALTER TABLE "ChatbotConfigStep"
    ADD CONSTRAINT "ChatbotConfigStep_approvedByOperatorId_fkey"
    FOREIGN KEY ("approvedByOperatorId") REFERENCES "Operator"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ── ChatbotConfigStepAudit ─────────────────────────────────────────────

CREATE TABLE "ChatbotConfigStepAudit" (
    "id"        TEXT         NOT NULL,
    "stepId"    TEXT         NOT NULL,
    -- Denormalized version at event time.
    "version"   INTEGER      NOT NULL,
    -- 'client' | 'operator' | 'system'. Server-side only.
    "actor"     TEXT         NOT NULL,
    -- Email or operator UUID. NULL for 'system' events.
    "actorId"   TEXT,
    -- 'edit' | 'submit' | 'approve' | 'request_revision' | 'activate' | 'deactivate'.
    "action"    TEXT         NOT NULL,
    -- Free-text reason (operator note, system trigger, etc.).
    "comment"   TEXT,
    "createdAt" TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT "ChatbotConfigStepAudit_pkey" PRIMARY KEY ("id")
);

-- FK: audit rows cascade-deleted when the parent step is removed.
ALTER TABLE "ChatbotConfigStepAudit"
    ADD CONSTRAINT "ChatbotConfigStepAudit_stepId_fkey"
    FOREIGN KEY ("stepId") REFERENCES "ChatbotConfigStep"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Lookup: all audit entries for a given step.
CREATE INDEX "ChatbotConfigStepAudit_stepId_idx"
    ON "ChatbotConfigStepAudit" ("stepId");

-- Timeline queries per step.
CREATE INDEX "ChatbotConfigStepAudit_stepId_createdAt_idx"
    ON "ChatbotConfigStepAudit" ("stepId", "createdAt");

-- Filter by actor type (e.g. all client edits).
CREATE INDEX "ChatbotConfigStepAudit_actor_idx"
    ON "ChatbotConfigStepAudit" ("actor");

-- Filter by action type (e.g. all approval events).
CREATE INDEX "ChatbotConfigStepAudit_action_idx"
    ON "ChatbotConfigStepAudit" ("action");
