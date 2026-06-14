-- KAIA-1177 (KAIA-1172 / AU-2) — per-step dedup for review-overdue kinds.
--
-- The review-overdue flow is per (clientId, stepId, kind, day) — different
-- wizard steps on the same client must not collapse into one notification
-- row. The existing @@unique([clientId, kind, day]) on OperatorNotification
-- stays in place (it serves stuck / execution-failed / escalation); we add
-- a `stepId` column and a partial unique index that only applies when
-- `stepId IS NOT NULL`, so review-overdue rows get the per-step dedup
-- without colliding with the client-level kind-disabled kinds.
--
-- The partial index is in operator timezone `day` (not UTC) — see the
-- `operator_day_in_tz` SQL function added in
-- 20260613123901_lifecycle_triggers_sql_functions for the reason: a
-- Friday-evening review in Madrid and a Saturday-morning re-fire should
-- land on the same `day` only when the operator is in the same working
-- timezone. The n8n flow passes the operator timezone on every call.
--
-- Reversibility: the rollback drops the partial index and the column.
-- Safe because review-overdue is the only producer and it does not ship
-- until KAIA-1177 lands.

ALTER TABLE "OperatorNotification"
  ADD COLUMN "stepId" TEXT;

-- Partial unique index — applies only to rows with a non-NULL stepId.
-- review-overdue rows always carry a stepId; the existing kinds do not.
CREATE UNIQUE INDEX "OperatorNotification_stepId_kind_day_key"
  ON "OperatorNotification" ("stepId", "kind", "day")
  WHERE "stepId" IS NOT NULL;

-- Lookup index for the "what have we already fired for this step today"
-- check the review-overdue/fire route runs before each insert.
CREATE INDEX "OperatorNotification_stepId_idx"
  ON "OperatorNotification" ("stepId");
