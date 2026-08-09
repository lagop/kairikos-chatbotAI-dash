-- Rollback for 20260809190000_kaia_13281_operator_action.
--
-- Order matters: drop the FK from OperatorAction first (DO block), then
-- drop the table, then drop the column on ChatbotClient. The OperatorAction
-- table has no inbound FKs, so this is safe even if audit rows already
-- exist (the cascade on the client FK would clean them up too, but we
-- drop explicitly to keep the rollback deterministic).
--
-- Take a backup of OperatorAction rows before running this in production
-- if you need to keep the audit trail.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'OperatorAction_client_id_fkey'
    ) THEN
        ALTER TABLE "OperatorAction" DROP CONSTRAINT "OperatorAction_client_id_fkey";
    END IF;
END$$;

DROP TABLE IF EXISTS "OperatorAction";

ALTER TABLE "ChatbotClient" DROP COLUMN IF EXISTS "notes";
