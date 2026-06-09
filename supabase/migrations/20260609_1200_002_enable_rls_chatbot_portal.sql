-- 20260609_1200_002_enable_rls_chatbot_portal.sql
-- Kairikos — Chatbot AI end-client portal (KAIA-731)
--
-- Enables Row Level Security on the four portal tables and installs the
-- per-tenant policies described in plan rev 2 §4.1.
--
-- Policy design:
--   * Default: deny. Every portal table is `enable row level security` AND
--     `force row level security` so even table owners respect RLS.
--   * Per-tenant access for end clients is gated by a SECURITY DEFINER
--     helper `public.chatbot_current_client_id()` that returns the
--     chatbot_clients.id of the calling auth.uid() via chatbot_client_users.
--   * Staff access (Kairikos operators) is gated by a JWT custom claim
--     `app_metadata.staff = true` (set via supabase auth admin). The
--     `public.chatbot_is_staff()` helper reads that claim.
--   * The Postgres `service_role` role already bypasses RLS in Supabase and
--     is the ONLY role used by n8n webhooks and the NestJS /admin/portal/*
--     support view backend. No policy explicitly grants to service_role.
--   * Revoked anonymous access: GRANTs on these tables are limited to
--     `anon`/`authenticated`/`service_role` for explicit allowlists only.
--
-- Reversibility: see the .down.sql companion.

begin;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- Returns the chatbot_clients.id for the calling auth.uid(), or NULL.
-- Marked SECURITY DEFINER + STABLE so RLS can use it inside policies.
-- Search-path is pinned to avoid search-path hijack.
create or replace function public.chatbot_current_client_id()
returns uuid
language sql
stable
security definer
set search_path = public, auth
as $$
  select ccu.client_id
  from public.chatbot_client_users ccu
  where ccu.user_id = auth.uid()
  limit 1
$$;

-- Returns true if the calling user is a Kairikos staff member.
-- v1: backed by auth.users.raw_app_meta_data->>'staff' = 'true'.
-- Set via Supabase auth admin (or service_role SQL) — never set from a portal JWT.
create or replace function public.chatbot_is_staff()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select coalesce(
    (auth.jwt() -> 'app_metadata' ->> 'staff')::boolean,
    false
  )
$$;

revoke all on function public.chatbot_current_client_id() from public;
grant execute on function public.chatbot_current_client_id() to authenticated, service_role;

revoke all on function public.chatbot_is_staff() from public;
grant execute on function public.chatbot_is_staff() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- chatbot_clients
-- ---------------------------------------------------------------------------
alter table public.chatbot_clients enable row level security;
alter table public.chatbot_clients force row level security;

drop policy if exists chatbot_clients_select_own on public.chatbot_clients;
create policy chatbot_clients_select_own
  on public.chatbot_clients
  for select
  to authenticated
  using (id = public.chatbot_current_client_id());

drop policy if exists chatbot_clients_select_staff on public.chatbot_clients;
create policy chatbot_clients_select_staff
  on public.chatbot_clients
  for select
  to authenticated
  using (public.chatbot_is_staff());

-- No insert/update/delete policies for authenticated.
-- Writes are exclusively via service_role (n8n + Stripe webhooks + /admin endpoints).
-- Force-RLS means even table owners cannot bypass.

-- ---------------------------------------------------------------------------
-- chatbot_client_users
-- ---------------------------------------------------------------------------
alter table public.chatbot_client_users enable row level security;
alter table public.chatbot_client_users force row level security;

drop policy if exists chatbot_client_users_select_own on public.chatbot_client_users;
create policy chatbot_client_users_select_own
  on public.chatbot_client_users
  for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists chatbot_client_users_select_staff on public.chatbot_client_users;
create policy chatbot_client_users_select_staff
  on public.chatbot_client_users
  for select
  to authenticated
  using (public.chatbot_is_staff());

-- No insert/update/delete policies. Mapping is created by service_role
-- (signup + invite flow on the backend). End users never edit their own mapping.

-- ---------------------------------------------------------------------------
-- chatbot_activity
-- ---------------------------------------------------------------------------
alter table public.chatbot_activity enable row level security;
alter table public.chatbot_activity force row level security;

drop policy if exists chatbot_activity_select_own on public.chatbot_activity;
create policy chatbot_activity_select_own
  on public.chatbot_activity
  for select
  to authenticated
  using (client_id = public.chatbot_current_client_id());

drop policy if exists chatbot_activity_select_staff on public.chatbot_activity;
create policy chatbot_activity_select_staff
  on public.chatbot_activity
  for select
  to authenticated
  using (public.chatbot_is_staff());

-- No insert/update/delete for authenticated. n8n T+N flows write via service_role.

-- ---------------------------------------------------------------------------
-- chatbot_conversations
-- ---------------------------------------------------------------------------
alter table public.chatbot_conversations enable row level security;
alter table public.chatbot_conversations force row level security;

drop policy if exists chatbot_conversations_select_own on public.chatbot_conversations;
create policy chatbot_conversations_select_own
  on public.chatbot_conversations
  for select
  to authenticated
  using (client_id = public.chatbot_current_client_id());

drop policy if exists chatbot_conversations_select_staff on public.chatbot_conversations;
create policy chatbot_conversations_select_staff
  on public.chatbot_conversations
  for select
  to authenticated
  using (public.chatbot_is_staff());

-- No insert/update/delete for authenticated. Conversation rows come from the
-- chatbot platform via n8n using service_role. Portal is read-only (plan §3.3).

-- ---------------------------------------------------------------------------
-- Explicit grants — keep tight
-- ---------------------------------------------------------------------------
-- The default `grant ... to public` is too permissive on Supabase projects.
-- Revoke from public, then grant only what the portal frontend needs.
revoke all on public.chatbot_clients        from public;
revoke all on public.chatbot_client_users   from public;
revoke all on public.chatbot_activity       from public;
revoke all on public.chatbot_conversations  from public;

-- The select policies above use `to authenticated`, which only takes effect
-- if the table privilege is granted. authenticated gets SELECT only.
grant select on public.chatbot_clients        to authenticated;
grant select on public.chatbot_client_users   to authenticated;
grant select on public.chatbot_activity       to authenticated;
grant select on public.chatbot_conversations  to authenticated;

-- service_role gets full DML (RLS is bypassed for service_role by Supabase).
grant select, insert, update, delete on public.chatbot_clients        to service_role;
grant select, insert, update, delete on public.chatbot_client_users   to service_role;
grant select, insert, update, delete on public.chatbot_activity       to service_role;
grant select, insert, update, delete on public.chatbot_conversations  to service_role;

commit;
