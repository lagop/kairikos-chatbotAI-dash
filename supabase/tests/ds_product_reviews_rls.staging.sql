\set ON_ERROR_STOP on

begin;

select set_config('reviews.smoke_failures', '0', false);

set local role service_role;

insert into public.reviews_configs (
  business_id,
  gbp_location_id,
  cadence_days,
  message_template,
  channel
)
select
  id,
  'accounts/smoke/locations/' || id::text,
  30,
  'Cuéntanos cómo fue tu experiencia',
  'email'
from public.chatbot_clients
where tenant_id is not null
order by created_at
limit 1
on conflict (business_id, gbp_location_id) do nothing;

reset role;

set local role authenticated;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', profile.id,
    'role', 'authenticated',
    'app_metadata', '{}'::jsonb
  )::text,
  true
)
from public.profiles profile
join public.chatbot_clients business on business.tenant_id = profile.tenant_id
join public.reviews_configs config on config.business_id = business.id
order by profile.created_at
limit 1;

select set_config(
  'request.jwt.claim.sub',
  (current_setting('request.jwt.claims')::jsonb ->> 'sub'),
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.app_metadata', '{}', true);

do $$
declare
  visible_count integer;
  foreign_count integer;
begin
  select count(*) into visible_count from public.reviews_configs;
  select count(*) into foreign_count
  from public.reviews_configs config
  join public.chatbot_clients business on business.id = config.business_id
  where business.tenant_id <> public.current_tenant_id();

  if visible_count < 1 then
    raise exception 'authenticated tenant could not read its review config';
  end if;

  if foreign_count <> 0 then
    raise exception 'cross-tenant review config leak: % rows', foreign_count;
  end if;
end;
$$;

reset role;
rollback;
