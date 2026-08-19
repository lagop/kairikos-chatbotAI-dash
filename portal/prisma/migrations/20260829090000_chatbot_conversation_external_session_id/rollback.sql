-- Rollback: ChatbotConversation.external_session_id
--
-- Safe as a straight drop — no other table references this column, and
-- rolling back just means future web-widget conversations fall back to
-- one-row-per-turn behavior until forward-migrated again.

DROP INDEX IF EXISTS "ChatbotConversation_clientId_external_session_id_key";
ALTER TABLE "ChatbotConversation" DROP COLUMN IF EXISTS "external_session_id";
