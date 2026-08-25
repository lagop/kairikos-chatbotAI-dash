-- Rollback for 20260905120000_recall_usage_month.
--
-- Safe as rollbacks go: every figure in this table is derived from
-- CallEvent and ReviewRequest, which are untouched, so dropping it loses
-- a cache rather than a record. Re-running the roll-up rebuilds it.
DROP TABLE IF EXISTS "RecallUsageMonth";
