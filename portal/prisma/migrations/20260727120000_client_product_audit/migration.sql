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

-- Split into two triggers, BEFORE and AFTER, instead of one BEFORE
-- trigger doing both jobs. The original single BEFORE INSERT OR UPDATE
-- trigger tried to INSERT the audit row referencing NEW."id" via a FK
-- to ClientProduct.id — but on INSERT, a BEFORE trigger fires before
-- the row physically exists in "ClientProduct", so that FK check
-- always failed (error 23503) for every single ClientProduct insert.
-- Never caught before because CI never runs `prisma migrate deploy`
-- against a real Postgres (see WP-03) and no environment had
-- successfully applied this migration and then inserted a row yet.
--
-- `changed_at` still needs a BEFORE trigger (only a BEFORE trigger can
-- mutate NEW to affect the stored row). The audit INSERT moves to an
-- AFTER trigger, where the row is guaranteed to exist for both INSERT
-- and UPDATE.
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
CREATE TRIGGER "ClientProduct_changed_at_trigger"
BEFORE INSERT OR UPDATE ON "ClientProduct"
FOR EACH ROW EXECUTE FUNCTION public.set_client_product_changed_at();

CREATE TRIGGER "ClientProduct_audit_trigger"
AFTER INSERT OR UPDATE ON "ClientProduct"
FOR EACH ROW EXECUTE FUNCTION public.audit_client_product_change();
