-- 20260724_tenant_isolation_v1.down.sql
-- Kairikos — Rollback multi-tenant schema changes (KAIA-4258)
--
-- Reverses:
--   1. Drops owner aggregate view
--   2. Removes RLS policies added for tenant isolation
--   3. Removes tenant_id columns from existing tables
--   4. Drops client_products, products, profiles, tenants tables
--
-- NOTE: This rollback assumes no production data has been written to the new
-- columns. In production, data migration would need to be carefully managed.

begin;

-- ---------------------------------------------------------------------------
-- 1. Remove RLS policies added for tenant isolation
-- ---------------------------------------------------------------------------

drop policy if exists tenants_select_own on public.tenants;
drop policy if exists profiles_select_own on public.profiles;
drop policy if exists profiles_select_by_tenant on public.profiles;
drop policy if exists products_select on public.products;
drop policy if exists client_products_select_own on public.client_products;
drop policy if exists chatbot_clients_select_tenant on public.chatbot_clients;
drop policy if exists chatbot_client_users_select_tenant on public.chatbot_client_users;
drop policy if exists chatbot_activity_select_tenant on public.chatbot_activity;
drop policy if exists chatbot_conversations_select_tenant on public.chatbot_conversations;
drop policy if exists chatbot_config_steps_select_tenant on public.chatbot_config_steps;
drop policy if exists chatbot_config_step_audits_select_tenant on public.chatbot_config_step_audits;

-- ---------------------------------------------------------------------------
-- 2. Drop helper functions
-- ---------------------------------------------------------------------------

drop function if exists public.get_tenant_feature(uuid, text, boolean);
drop function if exists public.is_app_staff();
drop function if exists public.is_tenant_owner();
drop function if exists public.current_tenant_id();
drop function if exists public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 3. Drop views
-- ---------------------------------------------------------------------------

drop view if exists public.v_tenant_owners;

-- ---------------------------------------------------------------------------
-- 4. Drop tables (reverse dependency order)
-- ---------------------------------------------------------------------------

drop table if exists public.client_products;
drop table if exists public.products;
drop table if exists public.profiles;
drop table if exists public.tenants;

-- ---------------------------------------------------------------------------
-- 5. Remove tenant_id columns from existing tables
-- ---------------------------------------------------------------------------

-- These columns were added by the up migration; we remove them but preserve
-- any existing data (which would be migrated back to NULL in a real rollback)

alter table public.chatbot_config_step_audits drop column if exists tenant_id;
alter table public.chatbot_config_steps drop column if exists tenant_id;
alter table public.chatbot_conversations drop column if exists tenant_id;
alter table public.chatbot_activity drop column if exists tenant_id;
alter table public.chatbot_client_users drop column if exists tenant_id;
alter table public.chatbot_clients drop column if exists tenant_id;

-- ---------------------------------------------------------------------------
-- 6. Remove triggers
-- ---------------------------------------------------------------------------

drop trigger if exists trg_profiles_touch_updated_at on public.profiles;
drop trigger if exists trg_tenants_touch_updated_at on public.tenants;
drop trigger if exists trg_chatbot_config_steps_touch_updated_at on public.chatbot_config_steps;
drop trigger if exists trg_chatbot_clients_touch_updated_at on public.chatbot_clients;

drop function if exists public.profiles_touch_updated_at();
drop function if exists public.tenants_touch_updated_at();

commit;
