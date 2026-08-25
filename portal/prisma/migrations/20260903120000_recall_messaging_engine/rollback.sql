-- Rollback for 20260903120000_recall_messaging_engine.
--
-- Dropping the blocklist table loses which numbers a client had silenced;
-- dropping the columns loses the delivery history. Neither is
-- reconstructible, so this is a real data loss, not a clean undo — it is
-- here for a failed deploy, not for a routine revert.
DROP TABLE IF EXISTS "RecallBlockedNumber";

DROP INDEX IF EXISTS "CallEvent_client_id_from_number_notified_caller_at_idx";
DROP INDEX IF EXISTS "CallEvent_notified_owner_at_started_at_idx";
DROP INDEX IF EXISTS "CallEvent_notified_caller_at_started_at_idx";

ALTER TABLE "CallEvent"
    DROP COLUMN IF EXISTS "owner_notify_attempts",
    DROP COLUMN IF EXISTS "owner_notify_error",
    DROP COLUMN IF EXISTS "caller_notify_attempts",
    DROP COLUMN IF EXISTS "caller_notify_error",
    DROP COLUMN IF EXISTS "caller_notify_channel";
