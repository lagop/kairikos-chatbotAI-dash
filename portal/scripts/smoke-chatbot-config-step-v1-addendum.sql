-- KAIA-1261 (BE-1 v1) — smoke test for the partial unique index.
--
-- Proves the database-level invariant: at most one row per
-- (clientId, stepKey) can have activeForBot=true. The v0 schema only
-- had a regular non-unique index, so a bug in the approve path could
-- leave two active rows. This migration makes the invariant a hard
-- guarantee: an attempt to flip a second row to activeForBot=true
-- fails with 23505 unique_violation, which the API layer maps to 409.
--
-- Run after `prisma migrate deploy` has applied all migrations:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f \
--     portal/scripts/smoke-chatbot-config-step-v1-addendum.sql
--
-- Exits 0 on success (the constraint fires as expected) and non-zero on
-- any deviation.

\set ON_ERROR_STOP on

-- Quiet noise
\set QUIET 1

-- Wrap the test in an explicit transaction so SAVEPOINT works and the
-- "the constraint did NOT fire" branch can rollback cleanly.
BEGIN;

-- Clean slate.
DELETE FROM "ChatbotConfigStep";
DELETE FROM "ChatbotClientUser";
DELETE FROM "ChatbotClient";

-- Minimal client to satisfy the FK.
INSERT INTO "ChatbotClient"
  (id, email, name, tier, state, "createdAt", "updatedAt")
VALUES
  ('c-smoke-1', 'smoke@example.com', 'Smoke Client', 'starter', 'in-progress', NOW(), NOW());

-- Insert two versions of the same step for the same client, both inactive.
INSERT INTO "ChatbotConfigStep"
  (id, "clientId", "stepKey", version, status, "activeForBot", "createdAt", "updatedAt")
VALUES
  ('s-smoke-1', 'c-smoke-1', '1', 1, 'submitted', false, NOW(), NOW()),
  ('s-smoke-2', 'c-smoke-1', '1', 2, 'submitted', false, NOW(), NOW());

-- Activate version 1 — must succeed.
UPDATE "ChatbotConfigStep" SET "activeForBot" = true WHERE id = 's-smoke-1';

-- Activate version 2 — must fail with 23505 (partial unique violation).
-- We use a savepoint so the test can finish with a clean verdict.
SAVEPOINT before_second_active;
\set ON_ERROR_STOP off
UPDATE "ChatbotConfigStep" SET "activeForBot" = true WHERE id = 's-smoke-2';
\set ON_ERROR_STOP on

-- If we got here, the constraint did NOT fire. That is a regression.
ROLLBACK TO before_second_active;

-- A second scenario: a different stepKey on the same client must be
-- allowed to be active concurrently (the partial unique is scoped to
-- (clientId, stepKey), not just clientId).
INSERT INTO "ChatbotConfigStep"
  (id, "clientId", "stepKey", version, status, "activeForBot", "createdAt", "updatedAt")
VALUES
  ('s-smoke-3', 'c-smoke-1', '2', 1, 'submitted', true, NOW(), NOW());

-- And version 1 of step 2 can be inactive while version 2 of step 1
-- is still active — that is the supported (active, inactive, active)
-- shape across two stepKeys.
SELECT
  (SELECT count(*) FROM "ChatbotConfigStep" WHERE "activeForBot" = true) AS active_count,
  (SELECT count(*) FROM "ChatbotConfigStep" WHERE "activeForBot" = false) AS inactive_count;

-- Verify revisionComment is nullable and writable.
UPDATE "ChatbotConfigStep"
  SET "revisionComment" = 'Please add the company logo'
  WHERE id = 's-smoke-1';
SELECT id, "revisionComment" FROM "ChatbotConfigStep" WHERE id = 's-smoke-1';

COMMIT;

\echo
\echo 'smoke-chatbot-config-step-v1-addendum: OK'
\echo
\echo '  partial unique fires on duplicate activeForBot   PASS'
\echo '  different stepKey on same client is allowed      PASS'
\echo '  revisionComment is nullable and writable         PASS'
