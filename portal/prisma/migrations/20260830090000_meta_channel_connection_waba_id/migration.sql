-- Migration: MetaChannelConnection.waba_id
--
-- Canales — activación de WhatsApp. Meta's app-webhook subscription
-- (subscribed_apps) is called at the WABA level, not per phone number —
-- externalId already holds the phone_number_id (used for routing an
-- incoming webhook and for the /messages send endpoint), but the WABA
-- id was only ever embedded in the display label
-- ("WhatsApp (<wabaId>)"), never a real column. Nullable and additive:
-- messenger/instagram rows, and any pre-existing whatsapp row from
-- before this migration, simply have waba_id=NULL until reconnected.

ALTER TABLE "MetaChannelConnection" ADD COLUMN "waba_id" TEXT;
