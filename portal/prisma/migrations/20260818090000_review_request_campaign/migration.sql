-- Migration: WP-22b — campañas de solicitud de reseñas

ALTER TABLE "GoogleBusinessConnection" ADD COLUMN IF NOT EXISTS "review_url" TEXT;

CREATE TABLE "ReviewRequestCampaign" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "connection_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewRequestCampaign_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ReviewRequestCampaign"
    ADD CONSTRAINT "ReviewRequestCampaign_connection_id_fkey"
    FOREIGN KEY ("connection_id") REFERENCES "GoogleBusinessConnection"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReviewRequestCampaign"
    ADD CONSTRAINT "ReviewRequestCampaign_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReviewRequestCampaign"
    ADD CONSTRAINT "ReviewRequestCampaign_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "ReviewRequestCampaign_client_id_idx" ON "ReviewRequestCampaign"("client_id");
CREATE INDEX "ReviewRequestCampaign_connection_id_idx" ON "ReviewRequestCampaign"("connection_id");

CREATE TABLE "ReviewRequest" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "campaign_id" UUID NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "recipient" TEXT NOT NULL,
    "recipient_name" TEXT,
    "consent_basis" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resend_message_id" TEXT,
    "send_error" TEXT,
    "sent_at" TIMESTAMP(3),
    "clicked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewRequest_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ReviewRequest"
    ADD CONSTRAINT "ReviewRequest_campaign_id_fkey"
    FOREIGN KEY ("campaign_id") REFERENCES "ReviewRequestCampaign"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ReviewRequest_campaign_id_recipient_key" ON "ReviewRequest"("campaign_id", "recipient");
CREATE INDEX "ReviewRequest_campaign_id_idx" ON "ReviewRequest"("campaign_id");
CREATE INDEX "ReviewRequest_status_idx" ON "ReviewRequest"("status");
