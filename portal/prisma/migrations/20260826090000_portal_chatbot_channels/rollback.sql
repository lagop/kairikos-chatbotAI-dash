-- Rollback: Canales del chatbot — instalación desde el wizard
--
-- Safe as a straight DROP as long as no channel connection has been
-- created yet (the expected state immediately after this migration
-- lands). If any client has already connected a channel, rolling back
-- destroys that connection's encrypted credentials — the client would
-- need to reconnect after a forward-migrate.

DROP TABLE IF EXISTS "ChannelWebhookDelivery";
DROP TABLE IF EXISTS "MetaChannelConnection";
DROP TABLE IF EXISTS "TelegramConnection";
DROP TABLE IF EXISTS "ChatWebEmbed";
