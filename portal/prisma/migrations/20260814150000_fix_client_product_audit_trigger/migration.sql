-- Migration: fix ClientProduct_audit_trigger INSERT ordering bug
--
-- 20260727120000_client_product_audit's original trigger was a single
-- BEFORE INSERT OR UPDATE trigger whose body, on INSERT, tried to write
-- a ClientProductAudit row referencing NEW."id" via a FK to
-- ClientProduct.id. A BEFORE trigger fires before the row physically
-- exists in "ClientProduct", so that FK check always failed (Postgres
-- error 23503) — for EVERY ClientProduct insert, on any database that
-- had this trigger installed. Never caught until now because CI never
-- runs `prisma migrate deploy` against a real Postgres (see WP-03) and
-- this project's local sandbox had no reachable database until today.
--
-- That source migration's file has already been corrected in place
-- (split into a BEFORE trigger that only sets changed_at, and an AFTER
-- trigger that does the audit INSERT — safe for both INSERT and
-- UPDATE), so a brand-new database applying the full chain from
-- scratch gets the fix directly. This migration repairs any database
-- that already recorded 20260727120000_client_product_audit as applied
-- and so still has the old, broken trigger installed. Idempotent: safe
-- to run even against a database that never had the bug.
CREATE OR REPLACE FUNCTION public.set_client_product_changed_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."changed_at" := NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.audit_client_product_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "ClientProductAudit" ("client_product_id", "client_id", "product_id", "tenant_id", "action", "status_after", "actor_id")
    VALUES (NEW."id", NEW."client_id", NEW."product_id", NEW."tenant_id", 'created', NEW."status", COALESCE(NEW."created_by", 'system'));
    RETURN NEW;
  END IF;

  INSERT INTO "ClientProductAudit" ("client_product_id", "client_id", "product_id", "tenant_id", "action", "status_before", "status_after", "actor_id")
  VALUES (NEW."id", NEW."client_id", NEW."product_id", NEW."tenant_id", CASE WHEN NEW."status" = OLD."status" THEN 'updated' ELSE NEW."status" END, OLD."status", NEW."status", COALESCE(NEW."changed_by", 'system'));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "ClientProduct_audit_trigger" ON "ClientProduct";
DROP TRIGGER IF EXISTS "ClientProduct_changed_at_trigger" ON "ClientProduct";

CREATE TRIGGER "ClientProduct_changed_at_trigger"
BEFORE INSERT OR UPDATE ON "ClientProduct"
FOR EACH ROW EXECUTE FUNCTION public.set_client_product_changed_at();

CREATE TRIGGER "ClientProduct_audit_trigger"
AFTER INSERT OR UPDATE ON "ClientProduct"
FOR EACH ROW EXECUTE FUNCTION public.audit_client_product_change();
