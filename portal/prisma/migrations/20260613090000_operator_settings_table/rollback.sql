-- Rollback: OperatorSettings + OperatorSettingsAudit (KAIA-1106)
-- Reverses migration 20260613090000_operator_settings_table.
--
-- Safe to revert only after verifying that no production code path reads
-- from OperatorSettings (KAIA-1084 API routes and KAIA-1083/1085 workers).
--
-- Order matters: drop the child table first to honour FK constraints.

DROP TABLE IF EXISTS "OperatorSettingsAudit";
DROP TABLE IF EXISTS "OperatorSettings";
