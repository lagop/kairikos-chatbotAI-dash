-- KAIA-14519 — roll back the COMMENT ON COLUMN to the pre-wizard-v1 wording.
-- The Text column type is unchanged; only the column comment is restored.
-- After rollback, application writes to 'ready' / 'updating' would still
-- succeed at the Prisma level (the column accepts any string) but would be
-- semantically divorced from the documented allowlist.
COMMENT ON COLUMN "ChatbotClient"."state" IS
  'Onboarding state. Allowed values (enforced server-side): '
  '  in-progress  — default for newly created clients '
  '  go-live-pending — client clicked "I''m ready for go-live" '
  '  live         — operator confirmed go-live; goLiveAt is also set.';
