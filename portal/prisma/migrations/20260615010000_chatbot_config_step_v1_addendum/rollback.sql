-- Rollback for 20260615010000_chatbot_config_step_v1_addendum.
--
-- Order: drop the partial unique index before the column (no dependency,
-- but symmetric with the up). Then drop the column. Then restore the
-- v0 COMMENT on ChatbotClient.state so the column-level documentation
-- matches reality for any subsequent migration.
--
-- This rollback is safe until the v1 wizard API (BE-2 / BE-3) starts
-- writing `state = ready | updating` or `ChatbotConfigStep.revisionComment`
-- in production. Before any of those land, run the rollback if needed.

DROP INDEX IF EXISTS "ChatbotConfigStep_activeForBot_partial_uniq";

ALTER TABLE "ChatbotConfigStep"
  DROP COLUMN IF EXISTS "revisionComment";

COMMENT ON COLUMN "ChatbotClient"."state" IS
  'Onboarding state machine. Allowed values: '
  '  in-progress  — default for newly created clients. '
  '  go-live-pending — client clicked "I''m ready for go-live". '
  '  live         — operator confirmed go-live; goLiveAt is also set. '
  'Enforced server-side; the route layer is the only writer.';
