-- RollbackChatbotClientState
-- Reverses migration 20260612150000_chatbot_client_state.
-- Safe to apply only after verifying that no production code reads
-- ChatbotClient.state (the /api/portal/onboarding/go-live-ready route
-- and the self-service UI buttons introduced in KAIA-1062).
DROP INDEX IF EXISTS "ChatbotClient_state_idx";
ALTER TABLE "ChatbotClient" DROP COLUMN IF EXISTS "state";
