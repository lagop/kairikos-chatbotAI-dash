-- AddSupabaseClientId
-- KAIA-762: enables the status-change watcher to resolve a Supabase UUID
-- (chatbot_clients.id) to the portal's ChatbotClient.id (cuid) by storing
-- the Supabase UUID as a column on the portal's ChatbotClient row.
--
-- Backfill: the join key between Supabase and portal is email
-- (chatbot_clients.primary_contact_email = ChatbotClient.email). The
-- backfill script (scripts/backfill-supabase-client-id.ts) uses this
-- path to populate supabaseClientId for all existing clients that have
-- a matching Supabase record.
--
-- Reversibility: the down migration drops the column, which is safe
-- only if no production code depends on it (enforced by the
-- require-supabase-client-id gate in KAIA-762's go-live checklist).
ALTER TABLE "ChatbotClient" ADD COLUMN "supabaseClientId" TEXT;
ALTER TABLE "ChatbotClient" ADD CONSTRAINT "ChatbotClient_supabaseClientId_key" UNIQUE ("supabaseClientId");