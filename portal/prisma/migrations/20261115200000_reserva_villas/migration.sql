-- Reserva propia para villas (15/11/2026) — nivel 3 del motor de reservas de
-- Signature. Plan: docs/plan-reserva-villas.md.
--
-- 1. La fila del catálogo. Complemento (kind 'addon') sin precio de catálogo
--    ni autoservicio: se vende dentro del presupuesto de Signature («desde
--    1.800 €, según número de villas») y lo activa el operador
--    (POST /api/admin/portal/villas). price_cents 0 a propósito: el importe es
--    el del presupuesto, no el de esta fila. Una contratación por cliente: NO
--    va en MULTI_INSTANCE_PRODUCT_CODES, así que el índice parcial único de
--    ClientProduct ya la cubre sin tocarlo.
INSERT INTO "Product" ("id", "code", "tier", "name", "price_cents", "setup_fee_cents", "currency", "features", "is_active", "self_serve_eligible", "kind")
VALUES (gen_random_uuid(), 'villas', 'standard', 'Reserva propia para villas', 0, 0, 'EUR', '{}'::jsonb, true, false, 'addon')
ON CONFLICT ("code", "tier") DO NOTHING;

-- 2. Las tablas del módulo.
-- CreateTable
CREATE TABLE "villa_rental" (
    "id" UUID NOT NULL,
    "client_product_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "public_token" TEXT NOT NULL,
    "business_name" TEXT NOT NULL,
    "owner_email" TEXT,
    "owner_phone" TEXT,
    "site_url" TEXT,
    "time_zone" TEXT NOT NULL DEFAULT 'Europe/Madrid',
    "deposit_percent" INTEGER NOT NULL DEFAULT 30,
    "confirm_hours" INTEGER NOT NULL DEFAULT 24,
    "payment_hours" INTEGER NOT NULL DEFAULT 48,
    "balance_note" TEXT,
    "cancellation_note" TEXT,
    "stripe_key_ciphertext" BYTEA,
    "stripe_key_iv" BYTEA,
    "stripe_key_tag" BYTEA,
    "stripe_key_hint" TEXT,
    "stripe_key_mode" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "villa_rental_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "villa" (
    "id" UUID NOT NULL,
    "rental_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "max_guests" INTEGER NOT NULL,
    "nightly_cents" INTEGER NOT NULL,
    "min_nights" INTEGER NOT NULL DEFAULT 2,
    "cleaning_fee_cents" INTEGER NOT NULL DEFAULT 0,
    "vat_rate_bps" INTEGER NOT NULL DEFAULT 1000,
    "tourist_tax_cents" INTEGER NOT NULL DEFAULT 0,
    "ical_token" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "villa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "villa_season" (
    "id" UUID NOT NULL,
    "villa_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "nightly_cents" INTEGER NOT NULL,
    "min_nights" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "villa_season_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "villa_calendar_feed" (
    "id" UUID NOT NULL,
    "villa_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "last_synced_at" TIMESTAMP(3),
    "last_status" TEXT,
    "last_error" TEXT,
    "event_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "villa_calendar_feed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "villa_block" (
    "id" UUID NOT NULL,
    "villa_id" UUID NOT NULL,
    "feed_id" UUID,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "uid" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "villa_block_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "villa_booking_request" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "guest_token" TEXT NOT NULL,
    "rental_id" UUID NOT NULL,
    "villa_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "check_in" DATE NOT NULL,
    "check_out" DATE NOT NULL,
    "adults" INTEGER NOT NULL,
    "children" INTEGER NOT NULL DEFAULT 0,
    "guest_name" TEXT NOT NULL,
    "guest_email" TEXT NOT NULL,
    "guest_phone" TEXT,
    "message" TEXT,
    "lang" TEXT NOT NULL DEFAULT 'es',
    "consent_at" TIMESTAMP(3) NOT NULL,
    "quote" JSONB NOT NULL,
    "total_cents" INTEGER NOT NULL,
    "deposit_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "decided_at" TIMESTAMP(3),
    "decline_reason" TEXT,
    "payment_due_at" TIMESTAMP(3),
    "stripe_session_id" TEXT,
    "stripe_payment_intent_id" TEXT,
    "paid_at" TIMESTAMP(3),
    "source" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "villa_booking_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "villa_rental_audit" (
    "id" UUID NOT NULL,
    "rental_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "villa_rental_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "villa_rental_client_product_id_key" ON "villa_rental"("client_product_id");

-- CreateIndex
CREATE UNIQUE INDEX "villa_rental_public_token_key" ON "villa_rental"("public_token");

-- CreateIndex
CREATE INDEX "villa_rental_client_id_idx" ON "villa_rental"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "villa_ical_token_key" ON "villa"("ical_token");

-- CreateIndex
CREATE INDEX "villa_client_id_idx" ON "villa"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "villa_rental_id_slug_key" ON "villa"("rental_id", "slug");

-- CreateIndex
CREATE INDEX "villa_season_villa_id_idx" ON "villa_season"("villa_id");

-- CreateIndex
CREATE INDEX "villa_calendar_feed_villa_id_idx" ON "villa_calendar_feed"("villa_id");

-- CreateIndex
CREATE INDEX "villa_block_villa_id_start_date_idx" ON "villa_block"("villa_id", "start_date");

-- CreateIndex
CREATE INDEX "villa_block_feed_id_idx" ON "villa_block"("feed_id");

-- CreateIndex
CREATE UNIQUE INDEX "villa_booking_request_reference_key" ON "villa_booking_request"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "villa_booking_request_guest_token_key" ON "villa_booking_request"("guest_token");

-- CreateIndex
CREATE INDEX "villa_booking_request_rental_id_status_idx" ON "villa_booking_request"("rental_id", "status");

-- CreateIndex
CREATE INDEX "villa_booking_request_villa_id_status_check_in_idx" ON "villa_booking_request"("villa_id", "status", "check_in");

-- CreateIndex
CREATE INDEX "villa_booking_request_status_expires_at_idx" ON "villa_booking_request"("status", "expires_at");

-- CreateIndex
CREATE INDEX "villa_booking_request_status_payment_due_at_idx" ON "villa_booking_request"("status", "payment_due_at");

-- CreateIndex
CREATE INDEX "villa_rental_audit_rental_id_created_at_idx" ON "villa_rental_audit"("rental_id", "created_at");

-- CreateIndex
CREATE INDEX "villa_rental_audit_entity_entity_id_idx" ON "villa_rental_audit"("entity", "entity_id");

-- AddForeignKey
ALTER TABLE "villa_rental" ADD CONSTRAINT "villa_rental_client_product_id_fkey" FOREIGN KEY ("client_product_id") REFERENCES "ClientProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "villa" ADD CONSTRAINT "villa_rental_id_fkey" FOREIGN KEY ("rental_id") REFERENCES "villa_rental"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "villa_season" ADD CONSTRAINT "villa_season_villa_id_fkey" FOREIGN KEY ("villa_id") REFERENCES "villa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "villa_calendar_feed" ADD CONSTRAINT "villa_calendar_feed_villa_id_fkey" FOREIGN KEY ("villa_id") REFERENCES "villa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "villa_block" ADD CONSTRAINT "villa_block_villa_id_fkey" FOREIGN KEY ("villa_id") REFERENCES "villa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "villa_block" ADD CONSTRAINT "villa_block_feed_id_fkey" FOREIGN KEY ("feed_id") REFERENCES "villa_calendar_feed"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "villa_booking_request" ADD CONSTRAINT "villa_booking_request_rental_id_fkey" FOREIGN KEY ("rental_id") REFERENCES "villa_rental"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "villa_booking_request" ADD CONSTRAINT "villa_booking_request_villa_id_fkey" FOREIGN KEY ("villa_id") REFERENCES "villa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "villa_rental_audit" ADD CONSTRAINT "villa_rental_audit_rental_id_fkey" FOREIGN KEY ("rental_id") REFERENCES "villa_rental"("id") ON DELETE CASCADE ON UPDATE CASCADE;

