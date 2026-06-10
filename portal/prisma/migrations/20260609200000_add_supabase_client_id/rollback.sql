-- RollbackAddSupabaseClientId
-- Reverses migration 20260609200000_add_supabase_client_id.
-- Safe to apply only after verifying no production code reads
-- ChatbotClient.supabaseClientId in the critical path.
ALTER TABLE "ChatbotClient" DROP COLUMN "supabaseClientId";