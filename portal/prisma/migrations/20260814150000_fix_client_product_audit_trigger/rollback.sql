-- Rollback: restores the original single BEFORE INSERT OR UPDATE
-- trigger from 20260727120000_client_product_audit. NOTE: that original
-- form is the one with the INSERT-ordering bug this migration fixes —
-- only roll back if you specifically need to reproduce that bug, e.g.
-- to re-verify a downstream fix.

CREATE OR REPLACE FUNCTION public.audit_client_product_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."changed_at" := NOW();
    INSERT INTO "ClientProductAudit" ("client_product_id", "client_id", "product_id", "tenant_id", "action", "status_after", "actor_id")
    VALUES (NEW."id", NEW."client_id", NEW."product_id", NEW."tenant_id", 'created', NEW."status", COALESCE(NEW."created_by", 'system'));
    RETURN NEW;
  END IF;

  NEW."changed_at" := NOW();
  INSERT INTO "ClientProductAudit" ("client_product_id", "client_id", "product_id", "tenant_id", "action", "status_before", "status_after", "actor_id")
  VALUES (NEW."id", NEW."client_id", NEW."product_id", NEW."tenant_id", CASE WHEN NEW."status" = OLD."status" THEN 'updated' ELSE NEW."status" END, OLD."status", NEW."status", COALESCE(NEW."changed_by", 'system'));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "ClientProduct_changed_at_trigger" ON "ClientProduct";
DROP FUNCTION IF EXISTS public.set_client_product_changed_at();

DROP TRIGGER IF EXISTS "ClientProduct_audit_trigger" ON "ClientProduct";
CREATE TRIGGER "ClientProduct_audit_trigger"
BEFORE INSERT OR UPDATE ON "ClientProduct"
FOR EACH ROW EXECUTE FUNCTION public.audit_client_product_change();
