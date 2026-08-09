-- Rollback: remove User table and userId column (KAIA-2103)
-- Note: this rollback only works if ChatbotClientUser.userId is still nullable
-- (i.e., no other code has made it non-nullable).

ALTER TABLE "ChatbotClientUser" DROP CONSTRAINT IF EXISTS "ChatbotClientUser_userId_fkey";
ALTER TABLE "ChatbotClientUser" DROP COLUMN IF EXISTS "userId";
DROP TABLE IF EXISTS "User";
