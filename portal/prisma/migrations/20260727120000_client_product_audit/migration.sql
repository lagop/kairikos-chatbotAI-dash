-- Migration: CRUD support for Dashboard v2 products and client products.
-- Reversible via rollback.sql; archive audit rows before rollback in production.

CREATE TABLE "ClientProductAudit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "client_product_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "product_id" UUID NOT NULL,
    "tenant_id" UUID,
    "action" TEXT NOT NULL,
    "status_before" TEXT,
    "status_after" TEXT,
    "actor_id" TEXT NOT NULL,
    "changed_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "ClientProductAudit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ClientProductAudit_client_product_id_fkey"
        FOREIGN KEY ("client_product_id") REFERENCES "ClientProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ClientProductAudit_client_id_fkey"
        FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ClientProductAudit_product_id_fkey"
        FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ClientProductAudit_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "ClientProductAudit_client_product_id_changed_at_idx"
    ON "ClientProductAudit" ("client_product_id", "changed_at");
CREATE INDEX "ClientProductAudit_client_id_changed_at_idx"
    ON "ClientProductAudit" ("client_id", "changed_at");
CREATE INDEX "ClientProductAudit_tenant_id_idx"
    ON "ClientProductAudit" ("tenant_id");

ALTER TABLE "ClientProduct" ADD COLUMN "created_by" TEXT;
ALTER TABLE "ClientProduct" ADD COLUMN "changed_by" TEXT;
ALTER TABLE "ClientProduct" ADD COLUMN "changed_at" TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE "ClientProduct"
SET "created_by" = COALESCE("created_by", 'migration:20260727120000'),
    "changed_by" = COALESCE("changed_by", 'migration:20260727120000')
WHERE "created_by" IS NULL OR "changed_by" IS NULL;

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

DROP TRIGGER IF EXISTS "ClientProduct_audit_trigger" ON "ClientProduct";
CREATE TRIGGER "ClientProduct_audit_trigger"
BEFORE INSERT OR UPDATE ON "ClientProduct"
FOR EACH ROW EXECUTE FUNCTION public.audit_client_product_change();
