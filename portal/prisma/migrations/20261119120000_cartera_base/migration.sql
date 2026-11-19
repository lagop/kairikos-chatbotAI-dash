-- Cartera de Signature inmobiliaria (19/11/2026) — PR 1, «Portal, base».
-- Especificación aprobada: docs/fase1-cartera.md del repositorio
-- kairikos-signature-inmobiliaria.
--
-- 1. La fila del catálogo. Complemento (kind 'addon') sin precio de catálogo
--    ni autoservicio, como 'villas': se vende dentro del presupuesto de
--    Signature y lo activa el operador (POST /api/admin/portal/cartera o
--    «Productos contratados»). price_cents 0 a propósito: el importe es el del
--    presupuesto. Una contratación por cliente: NO va en
--    MULTI_INSTANCE_PRODUCT_CODES, así que el índice parcial único de
--    ClientProduct ya la cubre sin tocarlo.
INSERT INTO "Product" ("id", "code", "tier", "name", "price_cents", "setup_fee_cents", "currency", "features", "is_active", "self_serve_eligible", "kind")
VALUES (gen_random_uuid(), 'cartera', 'standard', 'Cartera inmobiliaria', 0, 0, 'EUR', '{}'::jsonb, true, false, 'addon')
ON CONFLICT ("code", "tier") DO NOTHING;

-- 2. Las tablas del módulo.
-- CreateTable
CREATE TABLE "cartera_site" (
    "id" UUID NOT NULL,
    "client_product_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "feed_token" TEXT NOT NULL,
    "build_secret_hash" TEXT,
    "github_repo" TEXT,
    "workflow_file" TEXT NOT NULL DEFAULT 'publicar.yml',
    "site_url" TEXT,
    "sale_prefix" TEXT NOT NULL DEFAULT 'C',
    "rent_prefix" TEXT NOT NULL DEFAULT 'A',
    "agents" JSONB NOT NULL DEFAULT '[]',
    "pending_since" TIMESTAMP(3),
    "last_dispatch_at" TIMESTAMP(3),
    "last_published_count" INTEGER,
    "exit_notified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cartera_site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cartera_home" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'borrador',
    "data" JSONB NOT NULL DEFAULT '{}',
    "errors" JSONB,
    "price" INTEGER,
    "title" TEXT,
    "slug_locked" BOOLEAN NOT NULL DEFAULT false,
    "first_published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "cartera_home_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cartera_photo" (
    "id" UUID NOT NULL,
    "home_id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "alt" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cartera_photo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cartera_enquiry" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "kind" TEXT NOT NULL,
    "refs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "name" TEXT,
    "contact" TEXT NOT NULL,
    "lang" TEXT NOT NULL DEFAULT 'es',
    "consent_at" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'nuevo',
    "lead_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cartera_enquiry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cartera_build" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "trigger" TEXT NOT NULL,
    "home_count" INTEGER NOT NULL,
    "dispatched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'enviada',
    "run_url" TEXT,
    "error" TEXT,

    CONSTRAINT "cartera_build_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cartera_audit" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cartera_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cartera_site_client_product_id_key" ON "cartera_site"("client_product_id");

-- CreateIndex
CREATE UNIQUE INDEX "cartera_site_feed_token_key" ON "cartera_site"("feed_token");

-- CreateIndex
CREATE INDEX "cartera_site_client_id_idx" ON "cartera_site"("client_id");

-- CreateIndex
CREATE INDEX "cartera_home_site_id_status_idx" ON "cartera_home"("site_id", "status");

-- CreateIndex
CREATE INDEX "cartera_home_client_id_idx" ON "cartera_home"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "cartera_home_site_id_ref_key" ON "cartera_home"("site_id", "ref");

-- CreateIndex
CREATE UNIQUE INDEX "cartera_photo_storage_key_key" ON "cartera_photo"("storage_key");

-- CreateIndex
CREATE INDEX "cartera_photo_home_id_position_idx" ON "cartera_photo"("home_id", "position");

-- CreateIndex
CREATE INDEX "cartera_enquiry_site_id_created_at_idx" ON "cartera_enquiry"("site_id", "created_at");

-- CreateIndex
CREATE INDEX "cartera_enquiry_created_at_idx" ON "cartera_enquiry"("created_at");

-- CreateIndex
CREATE INDEX "cartera_build_site_id_dispatched_at_idx" ON "cartera_build"("site_id", "dispatched_at");

-- CreateIndex
CREATE INDEX "cartera_audit_site_id_created_at_idx" ON "cartera_audit"("site_id", "created_at");

-- CreateIndex
CREATE INDEX "cartera_audit_entity_entity_id_idx" ON "cartera_audit"("entity", "entity_id");

-- AddForeignKey
ALTER TABLE "cartera_site" ADD CONSTRAINT "cartera_site_client_product_id_fkey" FOREIGN KEY ("client_product_id") REFERENCES "ClientProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cartera_home" ADD CONSTRAINT "cartera_home_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "cartera_site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cartera_photo" ADD CONSTRAINT "cartera_photo_home_id_fkey" FOREIGN KEY ("home_id") REFERENCES "cartera_home"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cartera_enquiry" ADD CONSTRAINT "cartera_enquiry_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "cartera_site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cartera_build" ADD CONSTRAINT "cartera_build_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "cartera_site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cartera_audit" ADD CONSTRAINT "cartera_audit_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "cartera_site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
