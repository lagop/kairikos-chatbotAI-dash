begin;

create extension if not exists pgcrypto;

create table public.reviews_configs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.chatbot_clients(id) on delete cascade,
  gbp_location_id text not null,
  cadence_days integer not null default 30 check (cadence_days between 1 and 365),
  message_template text not null,
  channel text not null check (channel in ('email', 'whatsapp')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, gbp_location_id)
);

create table public.reviews_requests (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.chatbot_clients(id) on delete cascade,
  customer_phone text,
  customer_email text,
  rating_token text not null unique,
  idem_key text not null unique,
  channel text not null check (channel in ('email', 'whatsapp')),
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'delivered', 'failed', 'rate_limited')),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  check (customer_phone is not null or customer_email is not null)
);

create table public.reviews_received (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.chatbot_clients(id) on delete cascade,
  request_id uuid references public.reviews_requests(id) on delete set null,
  rating integer not null check (rating between 1 and 5),
  comment text,
  customer_name text,
  reviewed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index reviews_configs_business_id_idx on public.reviews_configs (business_id);
create index reviews_configs_active_idx on public.reviews_configs (business_id, active) where active;
create index reviews_requests_business_id_idx on public.reviews_requests (business_id);
create index reviews_requests_status_idx on public.reviews_requests (business_id, status);
create index reviews_requests_sent_at_idx on public.reviews_requests (business_id, sent_at desc);
create index reviews_received_business_id_idx on public.reviews_received (business_id);
create index reviews_received_request_id_idx on public.reviews_received (request_id);
create index reviews_received_reviewed_at_idx on public.reviews_received (business_id, reviewed_at desc);

create function public.reviews_touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger reviews_configs_touch_updated_at
before update on public.reviews_configs
for each row execute function public.reviews_touch_updated_at();

alter table public.reviews_configs enable row level security;
alter table public.reviews_configs force row level security;
alter table public.reviews_requests enable row level security;
alter table public.reviews_requests force row level security;
alter table public.reviews_received enable row level security;
alter table public.reviews_received force row level security;

create policy reviews_configs_select_tenant
on public.reviews_configs for select to authenticated
using (
  exists (
    select 1
    from public.chatbot_clients business
    where business.id = reviews_configs.business_id
      and business.tenant_id = public.current_tenant_id()
  )
  or public.is_app_staff()
);

create policy reviews_configs_insert_tenant
on public.reviews_configs for insert to authenticated
with check (
  exists (
    select 1
    from public.chatbot_clients business
    where business.id = reviews_configs.business_id
      and business.tenant_id = public.current_tenant_id()
  )
);

create policy reviews_configs_update_tenant
on public.reviews_configs for update to authenticated
using (
  exists (
    select 1
    from public.chatbot_clients business
    where business.id = reviews_configs.business_id
      and business.tenant_id = public.current_tenant_id()
  )
)
with check (
  exists (
    select 1
    from public.chatbot_clients business
    where business.id = reviews_configs.business_id
      and business.tenant_id = public.current_tenant_id()
  )
);

create policy reviews_requests_select_tenant
on public.reviews_requests for select to authenticated
using (
  exists (
    select 1
    from public.chatbot_clients business
    where business.id = reviews_requests.business_id
      and business.tenant_id = public.current_tenant_id()
  )
  or public.is_app_staff()
);

create policy reviews_requests_insert_tenant
on public.reviews_requests for insert to authenticated
with check (
  exists (
    select 1
    from public.chatbot_clients business
    where business.id = reviews_requests.business_id
      and business.tenant_id = public.current_tenant_id()
  )
);

create policy reviews_requests_update_tenant
on public.reviews_requests for update to authenticated
using (
  exists (
    select 1
    from public.chatbot_clients business
    where business.id = reviews_requests.business_id
      and business.tenant_id = public.current_tenant_id()
  )
)
with check (
  exists (
    select 1
    from public.chatbot_clients business
    where business.id = reviews_requests.business_id
      and business.tenant_id = public.current_tenant_id()
  )
);

create policy reviews_received_select_tenant
on public.reviews_received for select to authenticated
using (
  exists (
    select 1
    from public.chatbot_clients business
    where business.id = reviews_received.business_id
      and business.tenant_id = public.current_tenant_id()
  )
  or public.is_app_staff()
);

create policy reviews_received_insert_tenant
on public.reviews_received for insert to authenticated
with check (
  exists (
    select 1
    from public.chatbot_clients business
    where business.id = reviews_received.business_id
      and business.tenant_id = public.current_tenant_id()
  )
);

create policy reviews_received_update_tenant
on public.reviews_received for update to authenticated
using (
  exists (
    select 1
    from public.chatbot_clients business
    where business.id = reviews_received.business_id
      and business.tenant_id = public.current_tenant_id()
  )
)
with check (
  exists (
    select 1
    from public.chatbot_clients business
    where business.id = reviews_received.business_id
      and business.tenant_id = public.current_tenant_id()
  )
);

grant select, insert, update on public.reviews_configs to authenticated;
grant select, insert, update on public.reviews_requests to authenticated;
grant select, insert, update on public.reviews_received to authenticated;
grant select, insert, update, delete on public.reviews_configs to service_role;
grant select, insert, update, delete on public.reviews_requests to service_role;
grant select, insert, update, delete on public.reviews_received to service_role;

commit;
