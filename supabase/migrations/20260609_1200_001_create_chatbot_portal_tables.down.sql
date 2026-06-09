-- 20260609_1200_001_create_chatbot_portal_tables.down.sql
-- Rollback for the up migration. Reverses in the opposite order.
-- SAFE on staging: drops only the objects created by the up migration.

begin;

drop trigger if exists trg_chatbot_clients_touch_updated_at on public.chatbot_clients;
drop function if exists public.chatbot_clients_touch_updated_at();

drop table if exists public.chatbot_conversations cascade;
drop table if exists public.chatbot_activity       cascade;
drop table if exists public.chatbot_client_users   cascade;
drop table if exists public.chatbot_clients        cascade;

commit;
