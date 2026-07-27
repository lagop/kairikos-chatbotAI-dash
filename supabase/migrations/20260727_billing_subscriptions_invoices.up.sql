-- 20260727_billing_subscriptions_invoices.up.sql
-- Kairikos — Multi-tenant Stripe billing (KAIA-4262)
--
-- Mirrors the Subscription / Invoice / StripeWebhookEvent tables added
-- in the portal Prisma migration
--   portal/prisma/migrations/20260727150000_billing_subscriptions_invoices/
-- so the same logical entities live in both DBs (portal Postgres owns
-- the write path from the Stripe webhook handler; Supabase owns the
-- owner-aggregation view).
--
-- Idempotency: every CREATE uses IF NOT EXISTS / drop policy if exists
-- so re-running is safe (matches supabase/scripts/apply-to-staging.sh
-- convention).
--
-- Reversibility: see the .down.sql companion. The drops are ordered:
--   invoices first (FK in), subscriptions next (FK out, referenced
--   by invoices), stripe_webhook_events (no FKs, last), tenant column
--   stripe_customer_id on tenants.

begin;

-- ---------------------------------------------------------------------------
-- 1. tenants — add stripe_customer_id link
-- ---------------------------------------------------------------------------
alter table public.tenants
    add column if not exists stripe_customer_id text;

create unique index if not exists tenants_stripe_customer_id_key
    on public.tenants (stripe_customer_id)
    where stripe_customer_id is not null;

-- ---------------------------------------------------------------------------
-- 2. subscriptions
-- ---------------------------------------------------------------------------
create table if not exists public.subscriptions (
    id                      uuid primary key default gen_random_uuid(),
    tenant_id               uuid not null references public.tenants(id) on delete restrict,
    client_id               uuid not null references public.chatbot_clients(id) on delete cascade,
    client_product_id       uuid not null references public.client_products(id) on delete cascade,
    stripe_id               text not null unique,
    stripe_customer_id      text not null,
    stripe_price_id         text,
    status                  text not null default 'incomplete',
    current_period_start    timestamptz,
    current_period_end      timestamptz,
    cancel_at_period_end    boolean not null default false,
    canceled_at             timestamptz,
    amount_cents            integer,
    currency                text not null default 'eur',
    metadata                jsonb not null default '{}'::jsonb,
    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now(),
    -- One Stripe Subscription maps to one ClientProduct (1:1) so the
    -- portal can show product-level billing state.
    constraint subscriptions_client_product_unique unique (client_product_id)
);

create index if not exists subscriptions_tenant_id_idx on public.subscriptions (tenant_id);
create index if not exists subscriptions_client_id_idx on public.subscriptions (client_id);
create index if not exists subscriptions_status_idx on public.subscriptions (status);
create index if not exists subscriptions_stripe_customer_id_idx on public.subscriptions (stripe_customer_id);

-- ---------------------------------------------------------------------------
-- 3. invoices
-- ---------------------------------------------------------------------------
create table if not exists public.invoices (
    id                      uuid primary key default gen_random_uuid(),
    tenant_id               uuid not null references public.tenants(id) on delete restrict,
    client_id               uuid not null references public.chatbot_clients(id) on delete cascade,
    subscription_id         uuid not null references public.subscriptions(id) on delete cascade,
    stripe_id               text not null unique,
    status                  text not null default 'draft',
    number                  text,
    amount_due_cents        integer not null default 0,
    amount_paid_cents       integer not null default 0,
    currency                text not null default 'eur',
    issued_at               timestamptz,
    due_at                  timestamptz,
    paid_at                 timestamptz,
    period_start            timestamptz,
    period_end              timestamptz,
    host_invoice_url        text,
    invoice_pdf_url         text,
    metadata                jsonb not null default '{}'::jsonb,
    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now()
);

create index if not exists invoices_tenant_id_idx on public.invoices (tenant_id);
create index if not exists invoices_client_id_idx on public.invoices (client_id);
create index if not exists invoices_subscription_id_idx on public.invoices (subscription_id);
create index if not exists invoices_status_idx on public.invoices (status);

-- ---------------------------------------------------------------------------
-- 4. stripe_webhook_events — idempotency log
-- ---------------------------------------------------------------------------
create table if not exists public.stripe_webhook_events (
    event_id                text primary key,
    event_type              text not null,
    payload_hash            text not null,
    received_at             timestamptz not null default now(),
    processed_at            timestamptz,
    status                  text not null default 'pending',
    error_message           text,
    applied_to              text,
    stripe_api_version      text
);

create index if not exists stripe_webhook_events_status_idx
    on public.stripe_webhook_events (status);
create index if not exists stripe_webhook_events_received_at_idx
    on public.stripe_webhook_events (received_at);

-- ---------------------------------------------------------------------------
-- 5. updated_at triggers
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at() returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

drop trigger if exists subscriptions_set_updated_at on public.subscriptions;
create trigger subscriptions_set_updated_at
    before update on public.subscriptions
    for each row execute function public.set_updated_at();

drop trigger if exists invoices_set_updated_at on public.invoices;
create trigger invoices_set_updated_at
    before update on public.invoices
    for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 6. RLS — same tenant-aware pattern as KAIA-4258 Phase 0
-- ---------------------------------------------------------------------------
-- Enable RLS on all three new tables.
alter table public.subscriptions enable row level security;
alter table public.invoices enable row level security;
alter table public.stripe_webhook_events enable row level security;

-- Helper that reads the caller's tenant_id from public.profiles.
-- CREATE OR REPLACE FUNCTION is idempotent: re-running the migration
-- just updates the function body to the same shape. Defined here in
-- case the prior migration (20260724_tenant_isolation_v1.up.sql) did
-- not install the helper.
--
-- Note: profiles.id references auth.users(id) (the PK), so the
-- tenant lookup joins on id = auth.uid().
create or replace function public.current_tenant_id() returns uuid
language sql stable security definer set search_path = public, auth as $func$
    select tenant_id from public.profiles
    where id = auth.uid()
    limit 1
$func$;

-- subscriptions: tenant-isolated read for owner/admin/viewer roles.
drop policy if exists subscriptions_select_tenant on public.subscriptions;
create policy subscriptions_select_tenant
    on public.subscriptions for select
    using (tenant_id = public.current_tenant_id());

drop policy if exists subscriptions_modify_service_role on public.subscriptions;
create policy subscriptions_modify_service_role
    on public.subscriptions for all
    using (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');

-- invoices: tenant-isolated read for owner/admin/viewer roles.
drop policy if exists invoices_select_tenant on public.invoices;
create policy invoices_select_tenant
    on public.invoices for select
    using (tenant_id = public.current_tenant_id());

drop policy if exists invoices_modify_service_role on public.invoices;
create policy invoices_modify_service_role
    on public.invoices for all
    using (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');

-- stripe_webhook_events: service-role only. No tenant read — the
-- idempotency log is operationally sensitive (Stripe event ids + error
-- messages) and only the billing backend (service_role) should see it.
drop policy if exists stripe_webhook_events_select_service_role on public.stripe_webhook_events;
create policy stripe_webhook_events_select_service_role
    on public.stripe_webhook_events for select
    using (auth.role() = 'service_role');

drop policy if exists stripe_webhook_events_modify_service_role on public.stripe_webhook_events;
create policy stripe_webhook_events_modify_service_role
    on public.stripe_webhook_events for all
    using (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');

commit;
