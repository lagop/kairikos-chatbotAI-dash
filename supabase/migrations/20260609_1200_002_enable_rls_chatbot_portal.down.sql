-- 20260609_1200_002_enable_rls_chatbot_portal.down.sql
-- Rollback for RLS policies and helpers.

begin;

-- Drop policies (idempotent)
drop policy if exists chatbot_conversations_select_staff on public.chatbot_conversations;
drop policy if exists chatbot_conversations_select_own   on public.chatbot_conversations;
drop policy if exists chatbot_activity_select_staff       on public.chatbot_activity;
drop policy if exists chatbot_activity_select_own         on public.chatbot_activity;
drop policy if exists chatbot_client_users_select_staff   on public.chatbot_client_users;
drop policy if exists chatbot_client_users_select_own     on public.chatbot_client_users;
drop policy if exists chatbot_clients_select_staff        on public.chatbot_clients;
drop policy if exists chatbot_clients_select_own          on public.chatbot_clients;

-- Restore default grants (so downgrading doesn't leave grants revoked)
grant select on public.chatbot_clients        to authenticated;
grant select on public.chatbot_client_users   to authenticated;
grant select on public.chatbot_activity       to authenticated;
grant select on public.chatbot_conversations  to authenticated;
grant select, insert, update, delete on public.chatbot_clients        to service_role;
grant select, insert, update, delete on public.chatbot_client_users   to service_role;
grant select, insert, update, delete on public.chatbot_activity       to service_role;
grant select, insert, update, delete on public.chatbot_conversations  to service_role;

-- Disable (do not drop) RLS so the tables remain usable like normal tables
-- if the down migration is applied without restoring an earlier state.
alter table public.chatbot_conversations  disable row level security;
alter table public.chatbot_activity       disable row level security;
alter table public.chatbot_client_users   disable row level security;
alter table public.chatbot_clients        disable row level security;

-- Drop helpers
drop function if exists public.chatbot_is_staff();
drop function if exists public.chatbot_current_client_id();

commit;
