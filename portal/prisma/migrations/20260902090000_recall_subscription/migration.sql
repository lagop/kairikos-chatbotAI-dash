-- WP-XX — Fase 1 de "Recuperación de llamadas perdidas + reseñas".
-- Satellite model 1:1 with ClientProduct (same shape as WebQuote) holding
-- the onboarding state machine, plus its append-only audit trail.
--
-- Note the column types: client_id is TEXT because ChatbotClient.id is a
-- cuid, while every *_id pointing at a uuid-keyed table is UUID.

CREATE TABLE "RecallSubscription" (
    "id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_product_id" UUID NOT NULL,
    "tenant_id" UUID,

    "status" TEXT NOT NULL DEFAULT 'paid',

    "contract_signed_at" TIMESTAMP(3),
    "meta_connected_at" TIMESTAMP(3),
    "number_assigned_at" TIMESTAMP(3),
    "templates_approved_at" TIMESTAMP(3),
    "forwarding_verified_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "paused_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),

    "owner_whatsapp" TEXT,
    "meta_connection_id" UUID,
    "google_connection_id" UUID,

    "greeting_audio" BYTEA,
    "greeting_mime_type" TEXT,
    "greeting_recorded_at" TIMESTAMP(3),

    "timezone" TEXT NOT NULL DEFAULT 'Europe/Madrid',
    "digest_hour" INTEGER NOT NULL DEFAULT 19,
    "business_hours" JSONB,
    "last_digest_at" TIMESTAMP(3),
    "last_report_at" TIMESTAMP(3),

    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecallSubscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RecallSubscription_client_product_id_key" ON "RecallSubscription"("client_product_id");
CREATE INDEX "RecallSubscription_client_id_idx" ON "RecallSubscription"("client_id");
CREATE INDEX "RecallSubscription_status_idx" ON "RecallSubscription"("status");
CREATE INDEX "RecallSubscription_tenant_id_idx" ON "RecallSubscription"("tenant_id");
CREATE INDEX "RecallSubscription_meta_connection_id_idx" ON "RecallSubscription"("meta_connection_id");
CREATE INDEX "RecallSubscription_google_connection_id_idx" ON "RecallSubscription"("google_connection_id");

ALTER TABLE "RecallSubscription"
    ADD CONSTRAINT "RecallSubscription_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RecallSubscription"
    ADD CONSTRAINT "RecallSubscription_client_product_id_fkey"
    FOREIGN KEY ("client_product_id") REFERENCES "ClientProduct"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RecallSubscription"
    ADD CONSTRAINT "RecallSubscription_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RecallSubscription"
    ADD CONSTRAINT "RecallSubscription_meta_connection_id_fkey"
    FOREIGN KEY ("meta_connection_id") REFERENCES "MetaChannelConnection"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RecallSubscription"
    ADD CONSTRAINT "RecallSubscription_google_connection_id_fkey"
    FOREIGN KEY ("google_connection_id") REFERENCES "GoogleBusinessConnection"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "RecallSubscriptionAudit" (
    "id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "actor_type" TEXT NOT NULL DEFAULT 'operator',
    "actor_operator_id" UUID,
    "actor_email" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecallSubscriptionAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RecallSubscriptionAudit_subscription_id_created_at_idx" ON "RecallSubscriptionAudit"("subscription_id", "created_at");
CREATE INDEX "RecallSubscriptionAudit_client_id_created_at_idx" ON "RecallSubscriptionAudit"("client_id", "created_at");
CREATE INDEX "RecallSubscriptionAudit_action_idx" ON "RecallSubscriptionAudit"("action");

ALTER TABLE "RecallSubscriptionAudit"
    ADD CONSTRAINT "RecallSubscriptionAudit_subscription_id_fkey"
    FOREIGN KEY ("subscription_id") REFERENCES "RecallSubscription"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RecallSubscriptionAudit"
    ADD CONSTRAINT "RecallSubscriptionAudit_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RecallSubscriptionAudit"
    ADD CONSTRAINT "RecallSubscriptionAudit_actor_operator_id_fkey"
    FOREIGN KEY ("actor_operator_id") REFERENCES "Operator"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
