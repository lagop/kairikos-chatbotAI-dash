-- Rollback: MetaChannelConnection.label

ALTER TABLE "MetaChannelConnection" DROP COLUMN IF EXISTS "label";
