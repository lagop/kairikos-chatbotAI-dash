-- WP-XX — Fase 7 de "Recuperación de llamadas perdidas + reseñas".
--
-- Two things: the token-lifecycle columns that close a silent-death bug,
-- and the per-client WhatsApp template registry.
--
-- The token columns are additive and nullable on purpose. NULL means
-- "unknown", which is the honest state for every connection made before
-- this migration: the exchange returned an expiry and the portal threw it
-- away, so we genuinely do not know when those tokens die. They are
-- treated as needing a re-check rather than assumed healthy.

ALTER TABLE "MetaChannelConnection" ADD COLUMN "token_expires_at" TIMESTAMP(3);
ALTER TABLE "MetaChannelConnection" ADD COLUMN "expiry_warned_at" TIMESTAMP(3);
ALTER TABLE "MetaChannelConnection" ADD COLUMN "display_phone_number" TEXT;
ALTER TABLE "MetaChannelConnection" ADD COLUMN "verified_name" TEXT;
ALTER TABLE "MetaChannelConnection" ADD COLUMN "quality_rating" TEXT;

CREATE INDEX "MetaChannelConnection_token_expires_at_idx" ON "MetaChannelConnection"("token_expires_at");

CREATE TABLE "WhatsappTemplate" (
    "id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "connection_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "language_code" TEXT NOT NULL,
    "meta_template_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "category" TEXT,
    "rejected_reason" TEXT,
    "last_checked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsappTemplate_pkey" PRIMARY KEY ("id")
);

-- Scoped the same way Meta scopes a template: one per name+language on a
-- given WABA connection.
CREATE UNIQUE INDEX "WhatsappTemplate_connection_id_name_language_code_key"
    ON "WhatsappTemplate"("connection_id", "name", "language_code");
CREATE INDEX "WhatsappTemplate_client_id_idx" ON "WhatsappTemplate"("client_id");
CREATE INDEX "WhatsappTemplate_status_idx" ON "WhatsappTemplate"("status");

ALTER TABLE "WhatsappTemplate"
    ADD CONSTRAINT "WhatsappTemplate_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WhatsappTemplate"
    ADD CONSTRAINT "WhatsappTemplate_connection_id_fkey"
    FOREIGN KEY ("connection_id") REFERENCES "MetaChannelConnection"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
