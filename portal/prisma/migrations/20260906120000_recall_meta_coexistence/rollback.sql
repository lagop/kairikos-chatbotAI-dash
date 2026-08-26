-- Rollback for 20260906120000_recall_meta_coexistence.
-- Only run this if Coexistence support is being reverted entirely —
-- dropping these columns loses the record of which connections are
-- coexistence-mode, which n8n's activation workflow needs to decide
-- whether to skip phone-number registration.

ALTER TABLE "MetaChannelConnection" DROP COLUMN IF EXISTS "platform_type";
ALTER TABLE "MetaChannelConnection" DROP COLUMN IF EXISTS "is_coexistence";
