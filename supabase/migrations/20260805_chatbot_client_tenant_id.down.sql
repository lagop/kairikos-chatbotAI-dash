-- 20260805_chatbot_client_tenant_id.down.sql
-- Reversal of 20260805_chatbot_client_tenant_id.up.sql
-- KAIA-10776

begin;

drop index if exists "ChatbotClient_tenant_id_idx";
alter table "ChatbotClient" drop column if exists tenant_id;

commit;
