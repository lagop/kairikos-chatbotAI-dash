-- Rollback for 20260727120000_client_product_audit.
-- Verify audit retention requirements and take a backup before applying.

DROP TRIGGER IF EXISTS "ClientProduct_audit_trigger" ON "ClientProduct";
DROP FUNCTION IF EXISTS public.audit_client_product_change();
DROP INDEX IF EXISTS "ClientProductAudit_tenant_id_idx";
DROP INDEX IF EXISTS "ClientProductAudit_client_id_changed_at_idx";
DROP INDEX IF EXISTS "ClientProductAudit_client_product_id_changed_at_idx";
DROP TABLE IF EXISTS "ClientProductAudit";
ALTER TABLE "ClientProduct" DROP COLUMN IF EXISTS "changed_at";
ALTER TABLE "ClientProduct" DROP COLUMN IF EXISTS "changed_by";
ALTER TABLE "ClientProduct" DROP COLUMN IF EXISTS "created_by";
