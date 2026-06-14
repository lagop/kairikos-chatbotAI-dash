-- KAIA-1261 (BE-1 v1) — ChatbotConfigStep v1 addendum.
--
-- v0 schema (KAIA-1163) shipped the ChatbotConfigStep + ChatbotConfigStepAudit
-- tables, but three v1-spec items were deferred. This migration fills them
-- in, all additively (no DROP, no destructive ALTER on existing tables).
--
-- 1. revisionComment on ChatbotConfigStep.
--    Spec: "`needs_revision` lleva siempre un comentario del operador
--    (`revision_comment`, textarea, obligatorio al rechazar)."
--    The original schema only stored the reason in the audit row, which
--    forces the portal GET to join the audit table to render the operator's
--    latest revision note. We now denormalize the latest operator reason
--    onto the step itself so the portal read path is a single round trip.
--    The audit row remains the source of truth for history; `revisionComment`
--    is a denormalized view of the most recent request_revision.
--    Backfill: NULL for existing rows. The wizard API will set it on the
--    next `request_revision` per step.
--
-- 2. Partial UNIQUE index `(clientId, stepKey) WHERE activeForBot = true`.
--    The bot's config loader is allowed to read at most one row per
--    (clientId, stepKey). The v0 schema only had a regular (non-unique)
--    index on `(clientId, stepKey, activeForBot)`, which means a bug in
--    the approve path could leave two active rows and the bot would
--    non-deterministically read either. The partial unique index makes
--    that invariant a database-level guarantee: an attempt to set a
--    second active row for the same (client, step) fails with 23505
--    unique_violation, which the API layer maps to 409.
--    Prisma does not model partial UNIQUE indexes; the matching non-unique
--    @@index lives in schema.prisma as a hint for query planning.
--
-- 3. ChatbotClient.state v1 enum values.
--    The current `state` column was introduced by KAIA-1062 with values
--    `in-progress` | `go-live-pending` | `live` (self-service "I'm ready
--    for go-live" flow). The v1 wizard requires two additional values:
--      * `ready`    — every mandatory step has reached `approved` for the
--                     first time (the wizard's "ready" state). n8n
--                     listens for the `config_complete` trigger at this
--                     transition.
--      * `updating` — a step moved to `needs_revision` or a new `draft`
--                     was created while the client was `live`. The bot
--                     keeps running on the last approved version per
--                     step until the operator approves the new one.
--    Postgres does not enforce a CHECK constraint on the column (the
--    route layer is the source of truth per the pattern set in
--    20260612150000_chatbot_client_state). This migration only documents
--    the extended allowlist via a COMMENT ON COLUMN.
--
-- Reversibility (rollback.sql):
--   * DROP COLUMN revisionComment
--   * DROP INDEX ChatbotConfigStep_activeForBot_partial_uniq
--   * COMMENT ON COLUMN "ChatbotClient"."state" — restored to the
--     v0 allowlist.
--   None of the changes are referenced by other migrations yet (no FK
--   to revisionComment, no other code path that relies on the partial
--   unique), so the rollback is safe at any point before production
--   code depends on them.

-- ---------------------------------------------------------------------------
-- 1. revisionComment on ChatbotConfigStep
-- ---------------------------------------------------------------------------
ALTER TABLE "ChatbotConfigStep"
  ADD COLUMN "revisionComment" TEXT;

COMMENT ON COLUMN "ChatbotConfigStep"."revisionComment" IS
  'Latest operator reason when the step was sent to needs_revision. '
  'Denormalized from the most recent ChatbotConfigStepAudit row with '
  'action=request_revision. NULL when the step has never been sent back. '
  'The audit table remains the source of truth for history.';

-- ---------------------------------------------------------------------------
-- 2. Partial UNIQUE index — at most one active row per (client, step)
-- ---------------------------------------------------------------------------
-- Prisma's @@unique cannot express a partial index, so we hand-write it.
-- The non-unique @@index in schema.prisma is a planning hint; this index
-- is the actual constraint.
CREATE UNIQUE INDEX "ChatbotConfigStep_activeForBot_partial_uniq"
    ON "ChatbotConfigStep" ("clientId", "stepKey")
    WHERE "activeForBot" = true;

COMMENT ON INDEX "ChatbotConfigStep_activeForBot_partial_uniq" IS
  'Enforces "at most one active row per (client, step)". The bot config '
  'loader relies on this invariant; duplicate actives are a 23505 '
  'unique_violation in the API layer (mapped to 409 Conflict).';

-- ---------------------------------------------------------------------------
-- 3. ChatbotClient.state v1 enum values (documentary)
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN "ChatbotClient"."state" IS
  'Onboarding state machine. Allowed values: '
  '  in-progress  — default for newly created clients (KAIA-1062). '
  '  go-live-pending — client clicked "I''m ready for go-live" (KAIA-1062). '
  '  live         — operator confirmed go-live; goLiveAt is also set (KAIA-1062). '
  '  ready        — wizard v1: every mandatory step reached approved for the '
  '                 first time. n8n listens for the config_complete trigger. '
  '  updating     — wizard v1: a step moved to needs_revision (or a new draft '
  '                 was created) while the client was live. The bot keeps '
  '                 running on the last approved version per step until the '
  '                 operator approves the new one. '
  'Enforced server-side; the route layer is the only writer.';
