-- Rollback for KAIA-1177 per-step dedup.
-- Drops the partial unique index + lookup index, then the column.
-- Safe: review-overdue is the only producer and doesn't ship until KAIA-1177.

DROP INDEX IF EXISTS "OperatorNotification_stepId_idx";
DROP INDEX IF EXISTS "OperatorNotification_stepId_kind_day_key";
ALTER TABLE "OperatorNotification" DROP COLUMN IF EXISTS "stepId";
