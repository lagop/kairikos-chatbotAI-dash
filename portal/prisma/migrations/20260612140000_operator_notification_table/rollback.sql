-- RollbackOperatorNotification
-- Reverses migration 20260612140000_operator_notification_table.
-- Safe to apply only after verifying no production code reads
-- OperatorNotification rows in the critical path (the dedup check
-- in /api/internal/notify-operator and the operator inbox view).
DROP TABLE IF EXISTS "OperatorNotification";
