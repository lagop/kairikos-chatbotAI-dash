-- Rollback: Canales Fase 7 — resúmenes periódicos de conversaciones
--
-- Safe as a straight DROP as long as no schedule/digest has been created
-- yet (the expected state immediately after this migration lands). If a
-- client already has digests, rolling back destroys that history — the
-- underlying ChatbotConversation rows are untouched, so a forward-migrate
-- can regenerate future digests, just not the historical ones.

DROP TABLE IF EXISTS "ConversationDigestSchedule";
DROP TABLE IF EXISTS "ConversationDigest";
