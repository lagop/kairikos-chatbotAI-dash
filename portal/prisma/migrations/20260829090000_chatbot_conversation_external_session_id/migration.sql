-- Migration: ChatbotConversation.external_session_id
--
-- Canales Fase 4 — the web widget generates a crypto-random session id
-- client-side per pageview and sends it with every turn. This column
-- lets POST /api/internal/channels/web/message upsert ONE
-- ChatbotConversation row per session (append to transcript, keep
-- duration current) instead of one row per message turn.
--
-- Nullable and additive: every pre-existing row (Telegram/WhatsApp
-- conversations, seed fixtures) has external_session_id=NULL, which
-- Postgres treats as distinct from every other NULL in a unique index,
-- so the new UNIQUE(client_id, external_session_id) constraint below
-- does not collide with any of them.

ALTER TABLE "ChatbotConversation" ADD COLUMN "external_session_id" TEXT;

CREATE UNIQUE INDEX "ChatbotConversation_clientId_external_session_id_key"
    ON "ChatbotConversation"("clientId", "external_session_id");
