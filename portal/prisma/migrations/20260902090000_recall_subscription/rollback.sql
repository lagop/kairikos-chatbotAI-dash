-- Rollback for 20260902090000_recall_subscription.
-- Drops both tables outright: no other table references them, and the
-- product they belong to is seeded isActive=false, so there is no live
-- data to preserve at the point this would realistically be run.

DROP TABLE IF EXISTS "RecallSubscriptionAudit";
DROP TABLE IF EXISTS "RecallSubscription";
