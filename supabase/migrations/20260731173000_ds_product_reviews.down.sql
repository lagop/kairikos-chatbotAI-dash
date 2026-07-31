begin;

drop policy if exists reviews_received_update_tenant on public.reviews_received;
drop policy if exists reviews_received_insert_tenant on public.reviews_received;
drop policy if exists reviews_received_select_tenant on public.reviews_received;
drop policy if exists reviews_requests_update_tenant on public.reviews_requests;
drop policy if exists reviews_requests_insert_tenant on public.reviews_requests;
drop policy if exists reviews_requests_select_tenant on public.reviews_requests;
drop policy if exists reviews_configs_update_tenant on public.reviews_configs;
drop policy if exists reviews_configs_insert_tenant on public.reviews_configs;
drop policy if exists reviews_configs_select_tenant on public.reviews_configs;

drop trigger if exists reviews_configs_touch_updated_at on public.reviews_configs;
drop function if exists public.reviews_touch_updated_at();

drop table if exists public.reviews_received;
drop table if exists public.reviews_requests;
drop table if exists public.reviews_configs;

commit;
