-- Rollback: KAIA-13281 — OperatorAction audit table + ChatbotClient.notes
--
-- Inverse of migration.sql. Run only after backing up any rows that
-- need to be preserved (the operator audit trail is forensically
-- valuable — do not drop silently).
--
-- Order:
--   1. Drop OperatorAction indexes, then the table itself. No other
--      model references OperatorAction, so there is no FK dependency
--      that needs to be unwound before DROP TABLE.
--   2. Drop ChatbotClient.notes. Pure additive column with no
--      dependencies; safe to drop.

BEGIN;

DROP INDEX IF EXISTS "OperatorAction_field_idx";
DROP INDEX IF EXISTS "OperatorAction_actor_id_idx";
DROP INDEX IF EXISTS "OperatorAction_client_id_created_at_idx";
DROP INDEX IF EXISTS "OperatorAction_client_id_idx";

DROP TABLE IF EXISTS "OperatorAction";

ALTER TABLE "ChatbotClient"
    DROP COLUMN IF EXISTS "notes";

COMMIT;