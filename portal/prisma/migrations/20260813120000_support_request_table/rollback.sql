-- Rollback: WP-11 — SupportRequest table
--
-- Inverse of migration.sql. Run only after backing up any rows that need
-- to be preserved (support requests are a customer-facing record — do
-- not drop silently).
--
-- No other model references SupportRequest, so there is no FK dependency
-- that needs to be unwound before DROP TABLE.

BEGIN;

DROP INDEX IF EXISTS "SupportRequest_tenant_id_idx";
DROP INDEX IF EXISTS "SupportRequest_status_created_at_idx";
DROP INDEX IF EXISTS "SupportRequest_status_idx";
DROP INDEX IF EXISTS "SupportRequest_client_id_created_at_idx";
DROP INDEX IF EXISTS "SupportRequest_client_id_idx";

DROP TABLE IF EXISTS "SupportRequest";

COMMIT;
