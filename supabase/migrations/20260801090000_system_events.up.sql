create table if not exists public.system_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  severity text not null check (severity in ('info', 'warning', 'error', 'critical')),
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists system_events_occurred_at_idx on public.system_events (occurred_at desc);
create index if not exists system_events_severity_idx on public.system_events (severity, occurred_at desc);

alter table public.system_events enable row level security;

create policy system_events_service_role_all on public.system_events
  for all to service_role using (true) with check (true);

create or replace function public.record_system_event(
  p_event_type text,
  p_severity text,
  p_payload jsonb default '{}'::jsonb
) returns public.system_events
language sql
security definer
set search_path = public
as $$
  insert into public.system_events (event_type, severity, payload)
  values (p_event_type, p_severity, coalesce(p_payload, '{}'::jsonb))
  returning *;
$$;

grant execute on function public.record_system_event(text, text, jsonb) to service_role;
