-- Rollback for 20260613103000_operator_identity_tables.
--
-- Order: drop child tables first (no FKs point at them, but symmetric
-- with the up). Then drop Operator. After this rollback runs, the
-- chain will fail at 20260613110000_chatbot_config_step_table because
-- that migration's approvedByOperatorId FK still references Operator.
-- The DBA / migration runner must therefore either re-apply this
-- migration or skip the config_step migration — do NOT run this
-- rollback against a database that has wizard v1 rows in production.

DROP TABLE IF EXISTS "OperatorRecoveryCode";
DROP TABLE IF EXISTS "OperatorSession";
DROP TABLE IF EXISTS "Operator";
