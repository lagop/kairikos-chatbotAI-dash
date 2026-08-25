-- Rollback for 20260902120000_whatsapp_templates_and_token_expiry.
-- Dropping the token columns restores the silent-death bug they close:
-- nothing would track when a Meta token expires. Only run this if the
-- whole 'recall' feature is being reverted.

DROP TABLE IF EXISTS "WhatsappTemplate";

DROP INDEX IF EXISTS "MetaChannelConnection_token_expires_at_idx";
ALTER TABLE "MetaChannelConnection" DROP COLUMN IF EXISTS "quality_rating";
ALTER TABLE "MetaChannelConnection" DROP COLUMN IF EXISTS "verified_name";
ALTER TABLE "MetaChannelConnection" DROP COLUMN IF EXISTS "display_phone_number";
ALTER TABLE "MetaChannelConnection" DROP COLUMN IF EXISTS "expiry_warned_at";
ALTER TABLE "MetaChannelConnection" DROP COLUMN IF EXISTS "token_expires_at";
