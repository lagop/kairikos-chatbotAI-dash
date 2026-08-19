-- Rollback: MetaChannelConnection.waba_id
--
-- Safe as a straight drop — no other table references this column.

ALTER TABLE "MetaChannelConnection" DROP COLUMN IF EXISTS "waba_id";
