-- 20260724_tenant_isolation_v1.up.sql
-- Kairikos — Multi-tenant schema for Dashboard v2 (KAIA-4258)
--
-- Creates the tenant isolation layer:
--   tenants          — one row per tenant organization
--   profiles         — extends auth.users with tenant_id (1:1)
--   products         — Kairikos service products (starter, pro, premium)
--   client_products  — many-to-many: chatbot_clients <-> products
--
-- Adds tenant_id FK to existing chatbot tables and updates RLS policies.
-- Creates helper functions and an owner aggregate view.
--
-- Reversibility: see the .down.sql companion.

begin;

-- ---------------------------------------------------------------------------
-- 1. tenants
-- ---------------------------------------------------------------------------
create table if not exists public.tenants (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null,
  slug        text        not null unique,
  -- 'active' | 'suspended' | 'cancelled'
  status      text        not null default 'active'
                check (status in ('active', 'suspended', 'cancelled')),
  -- Feature flag store (JSONB) for per-tenant rollout
  features    jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists tenants_slug_idx on public.tenants (slug);
create index if not exists tenants_status_idx on public.tenants (status) where status = 'active';

-- ---------------------------------------------------------------------------
-- 2. profiles  (extends auth.users)
-- ---------------------------------------------------------------------------
-- In v1 each auth.users maps to exactly one tenant via this profile row.
-- The profile is created automatically by a trigger on auth.users insert.
create table if not exists public.profiles (
  id              uuid        primary key references auth.users(id) on delete cascade,
  tenant_id       uuid        not null references public.tenants(id) on delete restrict,
  -- 'owner' | 'admin' | 'viewer' — owner sees all tenant data
  role            text        not null default 'viewer'
                  check (role in ('owner', 'admin', 'viewer')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id)
);

create index if not exists profiles_tenant_id_idx on public.profiles (tenant_id);
create index if not exists profiles_role_idx on public.profiles (role);

-- Auto-create profile on auth.users insert (before trigger is not possible on auth schema,
-- so we use a security definer function that runs on first login)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public, auth
as $$
begin
  -- Only create profile if not exists (handles backfill case)
  if not exists (select 1 from public.profiles where id = new.id) then
    insert into public.profiles (id, tenant_id, role)
    values (
      new.id,
      -- Default tenant for v1: create or reuse a "default" tenant
      coalesce(
        (select id from public.tenants where slug = 'default' limit 1),
        (insert into public.tenants (name, slug, status)
         values ('Default Tenant', 'default', 'active')
         on conflict (slug) do update set id = tenants.id
         returning id)
      ),
      'owner'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 3. products
-- ---------------------------------------------------------------------------
-- Kairikos service tiers. Source of truth is Stripe, but we store metadata
-- here for portal display and feature-gating.
create table if not exists public.products (
  id          uuid        primary key default gen_random_uuid(),
  stripe_price_id  text    unique,
  name        text        not null,
  tier        text        not null unique
              check (tier in ('starter', 'pro', 'premium')),
  price_cents integer     not null,
  currency    text        not null default 'EUR',
  features    jsonb       not null default '{}'::jsonb,
  is_active   boolean     not null default true,
  created_at  timestamptz not null default now()
);

create index if not exists products_tier_idx on public.products (tier);
create index if not exists products_is_active_idx on public.products (is_active) where is_active = true;

-- Seed starter products (idempotent)
insert into public.products (id, stripe_price_id, name, tier, price_cents, features)
values
  ('00000000-0000-0000-0000-000000000001', 'price_starter', 'Starter', 'starter', 9900,
   '{"max_conversations": 100, "max_users": 5, "support": "email"}'::jsonb),
  ('00000000-0000-0000-0000-000000000002', 'price_pro', 'Pro', 'pro', 24900,
   '{"max_conversations": 1000, "max_users": 20, "support": "priority"}'::jsonb),
  ('00000000-0000-0000-0000-000000000003', 'price_premium', 'Premium', 'premium', 49900,
   '{"max_conversations": -1, "max_users": -1, "support": "dedicated"}'::jsonb)
on conflict (tier) do update set
  stripe_price_id = excluded.stripe_price_id,
  name = excluded.name,
  price_cents = excluded.price_cents,
  features = excluded.features;

-- ---------------------------------------------------------------------------
-- 4. client_products (chatbot_clients <-> products many-to-many)
-- ---------------------------------------------------------------------------
create table if not exists public.client_products (
  id            uuid        primary key default gen_random_uuid(),
  client_id     uuid        not null references public.chatbot_clients(id) on delete cascade,
  product_id    uuid        not null references public.products(id) on delete restrict,
  -- 'active' | 'cancelled' | 'past_due'
  status        text        not null default 'active'
                check (status in ('active', 'cancelled', 'past_due')),
  subscribed_at  timestamptz not null default now(),
  cancelled_at   timestamptz,
  unique (client_id, product_id)
);

create index if not exists client_products_client_id_idx on public.client_products (client_id);
create index if not exists client_products_product_id_idx on public.client_products (product_id);
create index if not exists client_products_status_idx on public.client_products (status) where status = 'active';

-- ---------------------------------------------------------------------------
-- 5. Add tenant_id to existing chatbot tables
-- ---------------------------------------------------------------------------

-- chatbot_clients already has the tenant FK; we add the column
alter table public.chatbot_clients
  add column if not exists tenant_id uuid
  references public.tenants(id) on delete set null;

create index if not exists chatbot_clients_tenant_id_idx on public.chatbot_clients (tenant_id);

-- chatbot_client_users gets tenant_id via its profile
alter table public.chatbot_client_users
  add column if not exists tenant_id uuid
  references public.tenants(id) on delete set null;

create index if not exists chatbot_client_users_tenant_id_idx on public.chatbot_client_users (tenant_id);

-- chatbot_activity
alter table public.chatbot_activity
  add column if not exists tenant_id uuid
  references public.tenants(id) on delete set null;

create index if not exists chatbot_activity_tenant_id_idx on public.chatbot_activity (tenant_id);

-- chatbot_conversations
alter table public.chatbot_conversations
  add column if not exists tenant_id uuid
  references public.tenants(id) on delete set null;

create index if not exists chatbot_conversations_tenant_id_idx on public.chatbot_conversations (tenant_id);

-- chatbot_config_steps
alter table public.chatbot_config_steps
  add column if not exists tenant_id uuid
  references public.tenants(id) on delete set null;

create index if not exists chatbot_config_steps_tenant_id_idx on public.chatbot_config_steps (tenant_id);

-- chatbot_config_step_audits
alter table public.chatbot_config_step_audits
  add column if not exists tenant_id uuid
  references public.tenants(id) on delete set null;

create index if not exists chatbot_config_step_audits_tenant_id_idx on public.chatbot_config_step_audits (tenant_id);

-- ---------------------------------------------------------------------------
-- 6. Migrate existing data to default tenant (v1: single-tenant migration)
-- ---------------------------------------------------------------------------

-- Get or create default tenant
do $$
declare
  v_tenant_id uuid;
begin
  select id into v_tenant_id from public.tenants where slug = 'default';
  if v_tenant_id is null then
    insert into public.tenants (name, slug, status) values ('Default Tenant', 'default', 'active')
    returning id into v_tenant_id;
  end if;

  -- Migrate chatbot_clients
  update public.chatbot_clients set tenant_id = v_tenant_id where tenant_id is null;

  -- Migrate chatbot_client_users (via profile)
  update public.chatbot_client_users ccu
  set tenant_id = p.tenant_id
  from public.profiles p
  where ccu.user_id = p.id and ccu.tenant_id is null;

  -- Migrate chatbot_activity
  update public.chatbot_activity set tenant_id = v_tenant_id where tenant_id is null;

  -- Migrate chatbot_conversations
  update public.chatbot_conversations set tenant_id = v_tenant_id where tenant_id is null;

  -- Migrate chatbot_config_steps
  update public.chatbot_config_steps set tenant_id = v_tenant_id where tenant_id is null;

  -- Migrate chatbot_config_step_audits
  update public.chatbot_config_step_audits set tenant_id = v_tenant_id where tenant_id is null;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Helper functions for tenant resolution
-- ---------------------------------------------------------------------------

-- Returns the tenant_id for the calling auth.uid() via profiles, or NULL.
create or replace function public.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public, auth
as $$
  select p.tenant_id
  from public.profiles p
  where p.id = auth.uid()
  limit 1
$$;

revoke all on function public.current_tenant_id() from public;
grant execute on function public.current_tenant_id() to authenticated, service_role;

-- Returns true if the calling user is a tenant owner (role='owner')
create or replace function public.is_tenant_owner()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'owner'
  )
$$;

revoke all on function public.is_tenant_owner() from public;
grant execute on function public.is_tenant_owner() to authenticated, service_role;

-- Returns true if calling user can see all tenants (app-level staff)
create or replace function public.is_app_staff()
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

revoke all on function public.is_app_staff() from public;
grant execute on function public.is_app_staff() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. RLS for new tables
-- ---------------------------------------------------------------------------

-- tenants
alter table public.tenants enable row level security;
alter table public.tenants force row level security;

-- Owners see their own tenant; app staff see all
drop policy if exists tenants_select_own on public.tenants;
create policy tenants_select_own
  on public.tenants for select to authenticated
  using (id = public.current_tenant_id() or public.is_app_staff());

-- service_role bypasses RLS
grant select, insert, update, delete on public.tenants to service_role;
grant select on public.tenants to authenticated;

-- profiles
alter table public.profiles enable row level security;
alter table public.profiles force row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
  on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_app_staff());

drop policy if exists profiles_select_by_tenant on public.profiles;
create policy profiles_select_by_tenant
  on public.profiles for select to authenticated
  using (tenant_id = public.current_tenant_id() or public.is_app_staff());

grant select, insert, update on public.profiles to service_role;
grant select on public.profiles to authenticated;

-- products (read-only for authenticated, managed by service_role)
alter table public.products enable row level security;
alter table public.products force row level security;

drop policy if exists products_select on public.products;
create policy products_select
  on public.products for select to authenticated
  using (is_active = true or public.is_app_staff());

grant select, insert, update, delete on public.products to service_role;
grant select on public.products to authenticated;

-- client_products
alter table public.client_products enable row level security;
alter table public.client_products force row level security;

drop policy if exists client_products_select_own on public.client_products;
create policy client_products_select_own
  on public.client_products for select to authenticated
  using (
    exists (
      select 1 from public.chatbot_clients cc
      where cc.id = client_products.client_id
        and cc.tenant_id = public.current_tenant_id()
    )
    or public.is_app_staff()
  );

grant select, insert, update, delete on public.client_products to service_role;
grant select on public.client_products to authenticated;

-- ---------------------------------------------------------------------------
-- 9. Update existing RLS policies to use tenant_id
-- ---------------------------------------------------------------------------

-- chatbot_clients: add tenant-aware policy
drop policy if exists chatbot_clients_select_tenant on public.chatbot_clients;
create policy chatbot_clients_select_tenant
  on public.chatbot_clients for select to authenticated
  using (
    tenant_id = public.current_tenant_id()
    or public.is_app_staff()
    or public.is_tenant_owner()
  );

-- chatbot_client_users: tenant-aware
drop policy if exists chatbot_client_users_select_tenant on public.chatbot_client_users;
create policy chatbot_client_users_select_tenant
  on public.chatbot_client_users for select to authenticated
  using (
    tenant_id = public.current_tenant_id()
    or public.is_app_staff()
  );

-- chatbot_activity: tenant-aware
drop policy if exists chatbot_activity_select_tenant on public.chatbot_activity;
create policy chatbot_activity_select_tenant
  on public.chatbot_activity for select to authenticated
  using (
    tenant_id = public.current_tenant_id()
    or public.is_app_staff()
  );

-- chatbot_conversations: tenant-aware
drop policy if exists chatbot_conversations_select_tenant on public.chatbot_conversations;
create policy chatbot_conversations_select_tenant
  on public.chatbot_conversations for select to authenticated
  using (
    tenant_id = public.current_tenant_id()
    or public.is_app_staff()
  );

-- chatbot_config_steps: tenant-aware
drop policy if exists chatbot_config_steps_select_tenant on public.chatbot_config_steps;
create policy chatbot_config_steps_select_tenant
  on public.chatbot_config_steps for select to authenticated
  using (
    tenant_id = public.current_tenant_id()
    or public.is_app_staff()
  );

-- chatbot_config_step_audits: tenant-aware
drop policy if exists chatbot_config_step_audits_select_tenant on public.chatbot_config_step_audits;
create policy chatbot_config_step_audits_select_tenant
  on public.chatbot_config_step_audits for select to authenticated
  using (
    tenant_id = public.current_tenant_id()
    or public.is_app_staff()
  );

-- ---------------------------------------------------------------------------
-- 10. Owner aggregate view (staff/owner sees all tenants with stats)
-- ---------------------------------------------------------------------------

drop view if exists public.v_tenant_owners;
create view public.v_tenant_owners as
select
  t.id          as tenant_id,
  t.name        as tenant_name,
  t.slug        as tenant_slug,
  t.status      as tenant_status,
  t.created_at  as tenant_created_at,
  p.id          as owner_user_id,
  p.role        as owner_role,
  u.email       as owner_email,
  count(distinct cc.id)        as total_clients,
  count(distinct cp.id)       as total_products
from public.tenants t
join public.profiles p on p.tenant_id = t.id and p.role = 'owner'
join auth.users u on u.id = p.id
left join public.chatbot_clients cc on cc.tenant_id = t.id
left join public.client_products cp on cp.client_id = cc.id and cp.status = 'active'
group by t.id, t.name, t.slug, t.status, t.created_at, p.id, p.role, u.email;

grant select on public.v_tenant_owners to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 11. Feature flag helper
-- ---------------------------------------------------------------------------

-- Returns the feature flag value for a tenant, or the default if not set.
create or replace function public.get_tenant_feature(
  p_tenant_id uuid,
  p_feature_key text,
  p_default boolean default false
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (t.features ->> p_feature_key)::boolean,
    p_default
  )
  from public.tenants t
  where t.id = p_tenant_id
$$;

revoke all on function public.get_tenant_feature(uuid, text, boolean) from public;
grant execute on function public.get_tenant_feature(uuid, text, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 12. updated_at trigger for tenants
-- ---------------------------------------------------------------------------
create or replace function public.tenants_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_tenants_touch_updated_at on public.tenants;
create trigger trg_tenants_touch_updated_at
  before update on public.tenants
  for each row execute function public.tenants_touch_updated_at();

-- updated_at trigger for profiles
create or replace function public.profiles_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_touch_updated_at on public.profiles;
create trigger trg_profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.profiles_touch_updated_at();

commit;
