-- Migration: Canales del chatbot — instalación desde el wizard
--
-- Four new tables, one dedicated model per connection type (same
-- pattern as GoogleBusinessConnection, WP-21) — not a polymorphic
-- ChannelConnection table with a discriminator:
--
--   ChatWebEmbed            — the Web widget. public_token is NOT
--                              encrypted (it's meant to be pasted into
--                              public HTML), unlike the other two.
--   TelegramConnection       — bot token, encrypted at rest
--                              (AES-256-GCM, three separate Bytes
--                              columns, own dedicated key
--                              CHANNEL_CREDENTIAL_ENCRYPTION_KEY — see
--                              lib/operator-crypto.ts / channel-crypto.ts).
--   MetaChannelConnection    — WhatsApp/Messenger/Instagram. One row per
--                              surface (a single Meta OAuth grant can
--                              expose several phone numbers/Pages/IG
--                              accounts at once, unlike Google which
--                              assumes a single location).
--   ChannelWebhookDelivery   — the push bridge toward n8n (portal → n8n
--                              only, no read access from the external
--                              engine). connection_id is polymorphic
--                              (points at a row in one of the three
--                              tables above depending on
--                              connection_type) — no FK, same reasoning
--                              as other polymorphic references in this
--                              schema.
--
-- client_id has no @db.Uuid because ChatbotClient.id is a cuid() TEXT,
-- not a UUID (same as every other table referencing ChatbotClient).
--
-- Reversibility: see rollback.sql — a straight DROP of all four tables,
-- safe as long as no connection has been created yet (the expected
-- state immediately after this migration lands).

CREATE TABLE "ChatWebEmbed" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "public_token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'disabled',
    "primary_color" TEXT NOT NULL DEFAULT '#0E6B5E',
    "position" TEXT NOT NULL DEFAULT 'bottom-right',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatWebEmbed_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TelegramConnection" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "bot_token_ciphertext" BYTEA NOT NULL,
    "bot_token_iv" BYTEA NOT NULL,
    "bot_token_tag" BYTEA NOT NULL,
    "bot_username" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_sync_error" TEXT,

    CONSTRAINT "TelegramConnection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MetaChannelConnection" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "channel" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "access_token_ciphertext" BYTEA NOT NULL,
    "access_token_iv" BYTEA NOT NULL,
    "access_token_tag" BYTEA NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_sync_error" TEXT,

    CONSTRAINT "MetaChannelConnection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChannelWebhookDelivery" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "connection_type" TEXT NOT NULL,
    "connection_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelWebhookDelivery_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ChatWebEmbed"
    ADD CONSTRAINT "ChatWebEmbed_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChatWebEmbed"
    ADD CONSTRAINT "ChatWebEmbed_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TelegramConnection"
    ADD CONSTRAINT "TelegramConnection_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TelegramConnection"
    ADD CONSTRAINT "TelegramConnection_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MetaChannelConnection"
    ADD CONSTRAINT "MetaChannelConnection_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MetaChannelConnection"
    ADD CONSTRAINT "MetaChannelConnection_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ChannelWebhookDelivery"
    ADD CONSTRAINT "ChannelWebhookDelivery_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ChatWebEmbed_public_token_key" ON "ChatWebEmbed"("public_token");
CREATE INDEX "ChatWebEmbed_client_id_idx" ON "ChatWebEmbed"("client_id");
CREATE INDEX "ChatWebEmbed_tenant_id_idx" ON "ChatWebEmbed"("tenant_id");

CREATE UNIQUE INDEX "TelegramConnection_client_id_key" ON "TelegramConnection"("client_id");
CREATE INDEX "TelegramConnection_tenant_id_idx" ON "TelegramConnection"("tenant_id");
CREATE INDEX "TelegramConnection_status_idx" ON "TelegramConnection"("status");

CREATE UNIQUE INDEX "MetaChannelConnection_client_id_channel_external_id_key"
    ON "MetaChannelConnection"("client_id", "channel", "external_id");
CREATE INDEX "MetaChannelConnection_tenant_id_idx" ON "MetaChannelConnection"("tenant_id");
CREATE INDEX "MetaChannelConnection_status_idx" ON "MetaChannelConnection"("status");
CREATE INDEX "MetaChannelConnection_channel_idx" ON "MetaChannelConnection"("channel");

CREATE INDEX "ChannelWebhookDelivery_client_id_idx" ON "ChannelWebhookDelivery"("client_id");
CREATE INDEX "ChannelWebhookDelivery_status_idx" ON "ChannelWebhookDelivery"("status");
CREATE INDEX "ChannelWebhookDelivery_connection_type_connection_id_idx"
    ON "ChannelWebhookDelivery"("connection_type", "connection_id");
