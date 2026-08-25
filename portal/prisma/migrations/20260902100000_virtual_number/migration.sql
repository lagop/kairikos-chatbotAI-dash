-- WP-XX — Fase 2 de "Recuperación de llamadas perdidas + reseñas".
-- Pool of virtual numbers. Pre-provisioned in batches and assigned at
-- alta with a local UPDATE, so onboarding never blocks on the provider.

CREATE TABLE "VirtualNumber" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'twilio',
    "provider_sid" TEXT NOT NULL,
    "e164" TEXT NOT NULL,
    "country_code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'available',
    "subscription_id" UUID,
    "provisioned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_at" TIMESTAMP(3),
    "released_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VirtualNumber_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VirtualNumber_provider_sid_key" ON "VirtualNumber"("provider_sid");
CREATE UNIQUE INDEX "VirtualNumber_e164_key" ON "VirtualNumber"("e164");
-- One number per subscription, enforced by the database rather than only
-- by application code. Postgres allows many NULLs here, which is exactly
-- what "sitting in the pool" needs.
CREATE UNIQUE INDEX "VirtualNumber_subscription_id_key" ON "VirtualNumber"("subscription_id");
CREATE INDEX "VirtualNumber_status_idx" ON "VirtualNumber"("status");
CREATE INDEX "VirtualNumber_provider_idx" ON "VirtualNumber"("provider");
CREATE INDEX "VirtualNumber_country_code_status_idx" ON "VirtualNumber"("country_code", "status");

ALTER TABLE "VirtualNumber"
    ADD CONSTRAINT "VirtualNumber_subscription_id_fkey"
    FOREIGN KEY ("subscription_id") REFERENCES "RecallSubscription"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
