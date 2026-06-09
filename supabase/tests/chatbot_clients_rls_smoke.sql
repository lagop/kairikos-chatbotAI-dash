-- supabase/tests/chatbot_clients_rls_smoke.sql
-- Acceptance smoke for KAIA-731.
--
-- Implements the issue's acceptance criteria:
--   "psql smoke: log in as a client JWT and SELECT from `chatbot_clients`
--    returns only the row tied to that client; logging in as a different
--    client returns zero rows; service-role JWT returns all rows."
--
-- Run with:
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
--     -f supabase/tests/chatbot_clients_rls_smoke.sql
--
-- The test uses `set local role` and a local helper `auth.set_jwt(json)`
-- to simulate the JWT that the Supabase PostgREST layer would see. The
-- helper sets both `request.jwt.claims` (the json) AND the per-claim GUCs
-- (`request.jwt.claim.sub`, etc.) the way real Supabase parses them.
--
-- IMPORTANT: The role that runs this script must NOT be a Postgres
-- superuser, otherwise `set local role` will not engage the RLS policies.
-- In a Supabase project, run as the `postgres` user with the project
-- connection string. Locally, run as a non-superuser with membership
-- in the `authenticated` and `service_role` roles.
--
-- The script records any failures in a custom GUC `chatbot.smoke_failures`
-- and exits with an error if the counter is non-zero.

\set ON_ERROR_STOP on

-- All checks need to run inside a transaction so that `set local` and
-- the per-claim GUCs (`request.jwt.claim.sub`) persist across the
-- set_role/check/reset cycle.
begin;

-- Stable identifiers (overridable via psql -v)
\set fake_user_a '00000000-0000-0000-0000-0000000000a1'
\set fake_user_b '00000000-0000-0000-0000-0000000000a2'
\set fake_user_c '00000000-0000-0000-0000-0000000000a3'
\set fake_user_staff '00000000-0000-0000-0000-00000000staff'
\set client_a '11111111-1111-1111-1111-111111111111'
\set client_b '22222222-2222-2222-2222-222222222222'

-- Pre-computed JWT claim strings. Quoted with dollar-signs in psql -v
-- variables so braces survive unquoted. The helper auth.set_jwt takes the
-- raw json.
\set jwt_a     '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated","app_metadata":{}}'
\set jwt_b     '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated","app_metadata":{}}'
\set jwt_c     '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated","app_metadata":{}}'
\set jwt_staff '{"sub":"00000000-0000-0000-0000-00000000staff","role":"authenticated","app_metadata":{"staff":true}}'

\echo '=== KAIA-731 RLS smoke ==='

-- Failure counter (resets each run)
select set_config('chatbot.smoke_failures', '0', false);

-- -----------------------------------------------------------------------
-- 0. Sanity: RLS enabled on all four tables
-- -----------------------------------------------------------------------
\echo
\echo '-- 0. RLS enabled on all four tables'
do $$
declare
  missing text;
begin
  select string_agg(c.relname, ', ')
    into missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in (
      'chatbot_clients',
      'chatbot_client_users',
      'chatbot_activity',
      'chatbot_conversations'
    )
    and c.relrowsecurity = false;
  if missing is not null then
    raise exception 'RLS not enabled on: %', missing;
  end if;
  raise notice 'OK: RLS enabled on all four tables';
end$$;

-- -----------------------------------------------------------------------
-- Helper: a single do-block that sets the JWT, sets the role, runs a
-- count check, and tallies the failure. Uses EXECUTE because PL/pgSQL
-- does not substitute variables inside `SET LOCAL role`.
-- -----------------------------------------------------------------------
create or replace function pg_temp.check_rls(
  label text,
  jwt_json text,
  target_role text,
  expected_count int,
  expected_client_id text default null
) returns void
  language plpgsql
as $$
declare
  n int;
  seen text;
begin
  perform auth.set_jwt(jwt_json);
  execute format('set local role %I', target_role);
  select count(*) into n from public.chatbot_clients;
  if n <> expected_count then
    perform set_config('chatbot.smoke_failures',
      (current_setting('chatbot.smoke_failures')::int + 1)::text, false);
    raise warning 'FAIL: % expected % row(s), saw %', label, expected_count, n;
  elsif expected_client_id is not null then
    select id::text into seen from public.chatbot_clients limit 1;
    if seen <> expected_client_id then
      perform set_config('chatbot.smoke_failures',
        (current_setting('chatbot.smoke_failures')::int + 1)::text, false);
      raise warning 'FAIL: % saw wrong client: % (expected %)', label, seen, expected_client_id;
    else
      raise notice 'OK: % saw the right row', label;
    end if;
  else
    raise notice 'OK: % saw % row(s) (expected)', label, n;
  end if;
  execute 'reset role';
end$$;

-- -----------------------------------------------------------------------
-- 1-3. Client A / B / unmapped user
-- -----------------------------------------------------------------------
\echo
\echo '-- 1. Client A JWT: SELECT chatbot_clients returns exactly 1 row (own)'
select pg_temp.check_rls('Client A', :'jwt_a', 'authenticated', 1, :'client_a');

\echo
\echo '-- 2. Client B JWT: SELECT chatbot_clients returns exactly 1 row (own, different)'
select pg_temp.check_rls('Client B', :'jwt_b', 'authenticated', 1, :'client_b');

\echo
\echo '-- 3. Unmapped user: SELECT chatbot_clients returns 0 rows'
select pg_temp.check_rls('Unmapped', :'jwt_c', 'authenticated', 0);

-- -----------------------------------------------------------------------
-- 4. Service role — bypasses RLS, sees all rows
-- -----------------------------------------------------------------------
\echo
\echo '-- 4. service_role: SELECT chatbot_clients returns >= 2 rows'
do $$
declare
  n int;
begin
  set local role service_role;
  select count(*) into n from public.chatbot_clients;
  if n < 2 then
    perform set_config('chatbot.smoke_failures',
      (current_setting('chatbot.smoke_failures')::int + 1)::text, false);
    raise warning 'FAIL: service_role expected >= 2 rows, saw %', n;
  else
    raise notice 'OK: service_role saw % chatbot_clients rows', n;
  end if;
  reset role;
end$$;

-- -----------------------------------------------------------------------
-- 5. Cross-tenant isolation on chatbot_activity (Client A)
-- -----------------------------------------------------------------------
\echo
\echo '-- 5. Client A JWT: chatbot_activity shows only Client A events'
do $smoke$
declare
  bad_count int;
  jwt_a text := '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated","app_metadata":{}}';
begin
  perform auth.set_jwt(jwt_a);
  set local role authenticated;
  select count(*) into bad_count
  from public.chatbot_activity
  where client_id <> '11111111-1111-1111-1111-111111111111'::uuid;
  if bad_count > 0 then
    perform set_config('chatbot.smoke_failures',
      (current_setting('chatbot.smoke_failures')::int + 1)::text, false);
    raise warning 'FAIL: Client A saw % foreign-client activity rows', bad_count;
  else
    raise notice 'OK: Client A saw no foreign-client activity rows';
  end if;
  reset role;
end $smoke$;

-- -----------------------------------------------------------------------
-- 6. Cross-tenant isolation on chatbot_conversations (Client B)
-- -----------------------------------------------------------------------
\echo
\echo '-- 6. Client B JWT: chatbot_conversations shows only Client B rows'
do $smoke$
declare
  bad_count int;
  jwt_b text := '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated","app_metadata":{}}';
begin
  perform auth.set_jwt(jwt_b);
  set local role authenticated;
  select count(*) into bad_count
  from public.chatbot_conversations
  where client_id <> '22222222-2222-2222-2222-222222222222'::uuid;
  if bad_count > 0 then
    perform set_config('chatbot.smoke_failures',
      (current_setting('chatbot.smoke_failures')::int + 1)::text, false);
    raise warning 'FAIL: Client B saw % foreign-client conversation rows', bad_count;
  else
    raise notice 'OK: Client B saw no foreign-client conversation rows';
  end if;
  reset role;
end $smoke$;

-- -----------------------------------------------------------------------
-- 7. Authenticated cannot write
-- -----------------------------------------------------------------------
\echo
\echo '-- 7. Authenticated cannot insert into chatbot_clients'
do $smoke$
declare
  jwt_a text := '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated","app_metadata":{}}';
begin
  perform auth.set_jwt(jwt_a);
  set local role authenticated;
  begin
    insert into public.chatbot_clients (slug, company_name, primary_contact_email)
    values ('rls-bypass-attempt', 'RLS Bypass Attempt', 'rls-bypass@test.dev');
    perform set_config('chatbot.smoke_failures',
      (current_setting('chatbot.smoke_failures')::int + 1)::text, false);
    raise warning 'FAIL: authenticated was able to insert into chatbot_clients';
  exception
    when insufficient_privilege then
      raise notice 'OK: authenticated insert denied (insufficient_privilege)';
    when others then
      raise notice 'OK: authenticated insert denied (%)', SQLERRM;
  end;
  reset role;
end $smoke$;

-- -----------------------------------------------------------------------
-- 8. Staff JWT (with app_metadata.staff = true) sees all rows
-- -----------------------------------------------------------------------
\echo
\echo '-- 8. Staff JWT: SELECT chatbot_clients returns all rows'
do $smoke$
declare
  n int;
  jwt_staff text := '{"sub":"00000000-0000-0000-0000-00000000staff","role":"authenticated","app_metadata":{"staff":true}}';
begin
  perform auth.set_jwt(jwt_staff);
  set local role authenticated;
  select count(*) into n from public.chatbot_clients;
  if n < 2 then
    perform set_config('chatbot.smoke_failures',
      (current_setting('chatbot.smoke_failures')::int + 1)::text, false);
    raise warning 'FAIL: Staff expected >= 2 rows, saw %', n;
  else
    raise notice 'OK: staff saw % chatbot_clients rows', n;
  end if;
  reset role;
end $smoke$;

\echo
\echo '=== RLS smoke complete ==='

-- Final failure tally + hard fail
do $$
declare
  f int := current_setting('chatbot.smoke_failures')::int;
begin
  raise notice 'Failures: %', f;
  if f > 0 then
    raise exception 'RLS smoke had % failure(s)', f;
  end if;
end$$;

\echo '=== ALL RLS SMOKE CHECKS PASSED ==='

commit;
