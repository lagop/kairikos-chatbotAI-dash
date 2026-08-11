-- KAIA-14519 — ChatbotClient.state v1 wizard transitions ('ready',
-- 'updating') consolidation.
--
-- The schema column is TEXT (no Postgres ENUM, no CHECK constraint) and
-- the application layer in `src/lib/wizard-review.ts` is the source of
-- truth for which values the routes may write. The companion migration
-- `20260615010000_chatbot_config_step_v1_addendum/migration.sql`
-- already documents the extended allowlist via COMMENT ON COLUMN; this
-- migration re-affirms that contract under the KAIA-14519 issue so
-- psql-side audits have a single migration to point at for the wizard
-- v1 transitions specifically.
--
-- Idempotent: COMMENT ON COLUMN is replaced in place. No DDL — the
-- column type does not change. Reversible by restoring the COMMENT to
-- the v0 wording from 20260612150000_chatbot_client_state.
--
-- The application-layer edges that flip the column are:
--   * src/lib/wizard-review.ts:applyWizardReview (approve) → 'ready'
--   * src/lib/wizard-review.ts:applyWizardReview (request_revision on a
--     mandatory step) → 'updating'
--   * src/app/api/admin/portal/clients/[id]/route.ts → operator PATCH
--     can also write the values via the admin editor allowlist.
COMMENT ON COLUMN "ChatbotClient"."state" IS
  'Onboarding state machine. Allowed values: '
  '  in-progress    — default for newly created clients (KAIA-1062). '
  '  go-live-pending — client clicked "I''m ready for go-live" (KAIA-1062). '
  '  ready          — wizard v1: every mandatory step reached approved for '
  '                   the first time. Set by the operator wizard review edge '
  '                   (src/lib/wizard-review.ts:applyWizardReview, action=approve) '
  '                   and deduped against the (clientId, config_complete) '
  '                   operator notification row for the same UTC day (KAIA-14519). '
  '  live           — operator confirmed go-live; goLiveAt is also set (KAIA-1062). '
  '  updating       — wizard v1: a step moved to needs_revision (or a new draft '
  '                   was created) while the client was live. Set by the operator '
  '                   wizard review edge '
  '                   (src/lib/wizard-review.ts:applyWizardReview, action=request_revision) '
  '                   and deduped against the (clientId, config-updating) '
  '                   operator notification row for the same UTC day (KAIA-14519). '
  'Enforced server-side; the route layer is the only writer.';
