-- Rollback: remove passwordSetAt column from ChatbotClientUser (KAIA-2103)
ALTER TABLE "ChatbotClientUser" DROP COLUMN IF EXISTS "passwordSetAt";
