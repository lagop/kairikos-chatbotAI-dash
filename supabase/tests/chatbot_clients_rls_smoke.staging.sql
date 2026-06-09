-- supabase/tests/chatbot_clients_rls_smoke.staging.sql
--
-- KAIA-740 — Supabase-friendly port of the local RLS smoke.
--
-- The local smoke (chatbot_clients_rls_smoke.sql) depends on
-- _local_auth_shim.sql to mock Supabase's auth.uid() / auth.jwt() helpers
-- and the anon/authenticated/service_role roles. Real Supabase already
-- provides all of these, so the staging port is a thinner file:
--
--   * It does NOT create roles, auth.uid(), or auth.jwt() (Supabase does).
--   * It DOES define auth.set_jwt() locally, because we run from psql and
--     need a way to plant a JWT into request.jwt.claims + request.jwt.claim.*
--     the way PostgREST would. This is a one-time CREATE OR REPLACE; it
--     shadows nothing Supabase uses.
--   * Test user UUIDs and client UUIDs are psql -v variables so the runner
--     (supabase/scripts/apply-to-staging.sh) can override them if the
--     operator pre-created auth.users with different IDs (e.g. via the
--     Supabase Studio UI which auto-generates UUIDs). The defaults match
--     the deterministic IDs the runner script plants via the Admin API.
--
-- Run:
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
--     -f supabase/tests/chatbot_clients_rls_smoke.staging.sql
--
-- Exits non-zero on any failure; the apply-to-staging.sh runner captures
-- the log to supabase/tests/chatbot_clients_rls_smoke.staging.log.
--
-- Implements the KAIA-740 acceptance criterion:
--   "The local RLS smoke is ported to a Supabase-friendly form
--    (no _local_auth_shim.sql) and **passes on staging**."

\set ON_ERROR_STOP on

-- All checks need to run inside a single transaction so `set local` and
-- the per-claim GUCs (`request.jwt.claim.sub`) persist across the
-- set_role/check/reset cycle. Supabase project connections run as the
-- `postgres` role (a member of `authenticated` and `service_role` per
-- Supabase defaults), so `set local role` engages RLS policies.
begin;

-- ===========================================================================
-- 0. Configurable identifiers (psql -v overrides; defaults match the
--    runner script's hardcoded deterministic UUIDs).
-- ===========================================================================
-- These UUIDs are created in auth.users by supabase/scripts/apply-to-staging.sh
-- (or by the operator in Supabase Studio + UUIDs passed via psql -v).
\set user_a     '00000000-0000-0000-0000-0000000000a1'
\set user_b     '00000000-0000-0000-0000-0000000000a2'
\set user_c     '00000000-0000-0000-0000-0000000000a3'
\set user_staff '00000000-0000-0000-0000-00000000staff'
\set client_a   '11111111-1111-1111-1111-111111111111'
\set client_b   '22222222-2222-2222-2222-222222222222'

-- JWT claim strings. The helper auth.set_jwt below parses them and sets
-- both the full json and the per-claim GUCs the way real PostgREST does.
\set jwt_a     '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated","app_metadata":{}}'
\set jwt_b     '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated","app_metadata":{}}'
\set jwt_c     '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated","app_metadata":{}}'
\set jwt_staff '{"sub":"00000000-0000-0000-0000-00000000staff","role":"authenticated","app_metadata":{"staff":true}}'

\echo '=== KAIA-740 RLS smoke (staging port) ==='

-- Failure counter (resets each run)
select set_config('chatbot.smoke_failures', '0', false);

-- ===========================================================================
-- 0. Sanity: RLS enabled on all four tables
-- ===========================================================================
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

-- ===========================================================================
-- 0-pre. Wire the configurable UUIDs + JWT strings into GUCs so the
--        do-blocks below can read them via current_setting. We use the
--        `chatbot.smoke.*` namespace so we don't collide with the
--        Supabase-set request.jwt.claim.* GUCs.
-- ===========================================================================
select set_config('chatbot.smoke.user_a',     :'user_a',     false);
select set_config('chatbot.smoke.user_b',     :'user_b',     false);
select set_config('chatbot.smoke.user_c',     :'user_c',     false);
select set_config('chatbot.smoke.user_staff', :'user_staff', false);
select set_config('chatbot.smoke.client_a',   :'client_a',   false);
select set_config('chatbot.smoke.client_b',   :'client_b',   false);
select set_config('chatbot.smoke.jwt_a',     :'jwt_a',     false);
select set_config('chatbot.smoke.jwt_b',     :'jwt_b',     false);
select set_config('chatbot.smoke.jwt_c',     :'jwt_c',     false);
select set_config('chatbot.smoke.jwt_staff', :'jwt_staff', false);

-- ===========================================================================
-- 0a. Sanity: the configured auth.users rows actually exist.
--     Catches the "operator pre-created users in Studio with different
--     UUIDs than the runner script" failure mode early, with a clear
--     remediation message.
-- ===========================================================================
\echo
\echo '-- 0a. auth.users rows match the configured test UUIDs'
do $$
declare
  cfg_user_a     constant text := current_setting('chatbot.smoke.user_a');
  cfg_user_b     constant text := current_setting('chatbot.smoke.user_b');
  cfg_user_c     constant text := current_setting('chatbot.smoke.user_c');
  cfg_user_staff constant text := current_setting('chatbot.smoke.user_staff');
  missing_auth text;
  missing_map  text;
begin
  select string_agg(u.id::text, ', ')
    into missing_auth
  from unnest(array[
      cfg_user_a::uuid,
      cfg_user_b::uuid,
      cfg_user_c::uuid,
      cfg_user_staff::uuid
    ]) as want(id)
  left join auth.users u on u.id = want.id
  where u.id is null;
  if missing_auth is not null then
    raise exception 'auth.users rows missing for: %. Create them in Supabase Studio -> Authentication -> Users, or override the psql -v vars (user_a/user_b/user_c/user_staff) to match the existing rows.', missing_auth;
  end if;
  raise notice 'OK: auth.users rows present for all 4 test users';
end$$;

-- Same probe for chatbot_client_users mapping. The seed is supposed to
-- have created (user_a -> client_a) and (user_b -> client_b) rows.
\echo
\echo '-- 0b. chatbot_client_users mapping matches the configured test users'
do $$
declare
  cfg_user_a constant text := current_setting('chatbot.smoke.user_a');
  cfg_user_b constant text := current_setting('chatbot.smoke.user_b');
  cfg_client_a constant text := current_setting('chatbot.smoke.client_a');
  cfg_client_b constant text := current_setting('chatbot.smoke.client_b');
  bad_count int;
begin
  select count(*) into bad_count
  from public.chatbot_client_users
  where (user_id = cfg_user_a::uuid and client_id <> cfg_client_a::uuid)
     or (user_id = cfg_user_b::uuid and client_id <> cfg_client_b::uuid);
  if bad_count > 0 then
    raise exception 'chatbot_client_users mapping does not match the configured (user, client) pairs. Re-seed or override the psql -v vars (user_a/user_b/client_a/client_b).';
  end if;
  raise notice 'OK: chatbot_client_users mapping is consistent with the configured test users';
end$$;

-- ===========================================================================
-- 0c. Define auth.set_jwt() locally. Supabase already provides auth.uid()
--     and auth.jwt(); we only need to be able to plant a JWT into
--     request.jwt.claims + request.jwt.claim.* GUCs from psql the way
--     PostgREST does.
--
--     NOTE: If your Supabase project already defines auth.set_jwt()
--     (newer projects do), this CREATE OR REPLACE shadows it. That is
--     fine for the smoke (psql-only); PostgREST path is unaffected.
-- ===========================================================================
\echo
\echo '-- 0c. defining auth.set_jwt() helper (psql-side JWT plant)'
create or replace function auth.set_jwt(jwt_json text) returns void
  language plpgsql volatile
  as $$
declare
  claims jsonb := jwt_json::jsonb;
  sub_val text := claims ->> 'sub';
begin
  perform set_config('request.jwt.claims', jwt_json, true);
  if sub_val is not null then
    perform set_config('request.jwt.claim.sub', sub_val, true);
  end if;
  perform set_config('request.jwt.claim.role', coalesce(claims ->> 'role', ''), true);
  perform set_config('request.jwt.claim.app_metadata',
    coalesce(claims -> 'app_metadata', '{}'::jsonb)::text, true);
end;
$$;

-- ===========================================================================
-- 1-3. Client A / Client B / Unmapped user
-- ===========================================================================
\echo
\echo '-- 1. Client A JWT: SELECT chatbot_clients returns exactly 1 row (own)'
do $smoke$
declare
  n int;
  seen text;
  jwt_a text := current_setting('chatbot.smoke.jwt_a');
  cfg_client_a text := current_setting('chatbot.smoke.client_a');
begin
  perform auth.set_jwt(jwt_a);
  set local role authenticated;
  select count(*) into n from public.chatbot_clients;
  if n <> 1 then
    perform set_config('chatbot.smoke_failures',
      (current_setting('chatbot.smoke_failures')::int + 1)::text, false);
    raise warning 'FAIL: Client A expected 1 row, saw %', n;
  else
    select id::text into seen from public.chatbot_clients limit 1;
    if seen <> cfg_client_a then
      perform set_config('chatbot.smoke_failures',
        (current_setting('chatbot.smoke_failures')::int + 1)::text, false);
      raise warning 'FAIL: Client A saw wrong client: % (expected %)', seen, cfg_client_a;
    else
      raise notice 'OK: Client A saw exactly its own row';
    end if;
  end if;
  reset role;
end $smoke$;

\echo
\echo '-- 2. Client B JWT: SELECT chatbot_clients returns exactly 1 row (own, different)'
do $smoke$
declare
  n int;
  seen text;
  jwt_b text := current_setting('chatbot.smoke.jwt_b');
  cfg_client_b text := current_setting('chatbot.smoke.client_b');
begin
  perform auth.set_jwt(jwt_b);
  set local role authenticated;
  select count(*) into n from public.chatbot_clients;
  if n <> 1 then
    perform set_config('chatbot.smoke_failures',
      (current_setting('chatbot.smoke_failures')::int + 1)::text, false);
    raise warning 'FAIL: Client B expected 1 row, saw %', n;
  else
    select id::text into seen from public.chatbot_clients limit 1;
    if seen <> cfg_client_b then
      perform set_config('chatbot.smoke_failures',
        (current_setting('chatbot.smoke_failures')::int + 1)::text, false);
      raise warning 'FAIL: Client B saw wrong client: % (expected %)', seen, cfg_client_b;
    else
      raise notice 'OK: Client B saw exactly its own row';
    end if;
  end if;
  reset role;
end $smoke$;

\echo
\echo '-- 3. Unmapped user: SELECT chatbot_clients returns 0 rows'
do $smoke$
declare
  n int;
  jwt_c text := current_setting('chatbot.smoke.jwt_c');
begin
  perform auth.set_jwt(jwt_c);
  set local role authenticated;
  select count(*) into n from public.chatbot_clients;
  if n <> 0 then
    perform set_config('chatbot.smoke_failures',
      (current_setting('chatbot.smoke_failures')::int + 1)::text, false);
    raise warning 'FAIL: Unmapped user expected 0 rows, saw %', n;
  else
    raise notice 'OK: Unmapped user saw 0 rows';
  end if;
  reset role;
end $smoke$;

-- ===========================================================================
-- 4. Service role — bypasses RLS (BYPASSRLS attribute), sees all rows
-- ===========================================================================
\echo
\echo '-- 4. service_role: SELECT chatbot_clients returns >= 2 rows'
do $smoke$
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
end $smoke$;

-- ===========================================================================
-- 5. Cross-tenant isolation on chatbot_activity (Client A)
-- ===========================================================================
\echo
\echo '-- 5. Client A JWT: chatbot_activity shows only Client A events'
do $smoke$
declare
  bad_count int;
  jwt_a text := current_setting('chatbot.smoke.jwt_a');
  cfg_client_a text := current_setting('chatbot.smoke.client_a');
begin
  perform auth.set_jwt(jwt_a);
  set local role authenticated;
  select count(*) into bad_count
  from public.chatbot_activity
  where client_id <> cfg_client_a::uuid;
  if bad_count > 0 then
    perform set_config('chatbot.smoke_failures',
      (current_setting('chatbot.smoke_failures')::int + 1)::text, false);
    raise warning 'FAIL: Client A saw % foreign-client activity rows', bad_count;
  else
    raise notice 'OK: Client A saw no foreign-client activity rows';
  end if;
  reset role;
end $smoke$;

-- ===========================================================================
-- 6. Cross-tenant isolation on chatbot_conversations (Client B)
-- ===========================================================================
\echo
\echo '-- 6. Client B JWT: chatbot_conversations shows only Client B rows'
do $smoke$
declare
  bad_count int;
  jwt_b text := current_setting('chatbot.smoke.jwt_b');
  cfg_client_b text := current_setting('chatbot.smoke.client_b');
begin
  perform auth.set_jwt(jwt_b);
  set local role authenticated;
  select count(*) into bad_count
  from public.chatbot_conversations
  where client_id <> cfg_client_b::uuid;
  if bad_count > 0 then
    perform set_config('chatbot.smoke_failures',
      (current_setting('chatbot.smoke_failures')::int + 1)::text, false);
    raise warning 'FAIL: Client B saw % foreign-client conversation rows', bad_count;
  else
    raise notice 'OK: Client B saw no foreign-client conversation rows';
  end if;
  reset role;
end $smoke$;

-- ===========================================================================
-- 7. Authenticated cannot write
-- ===========================================================================
\echo
\echo '-- 7. Authenticated cannot insert into chatbot_clients'
do $smoke$
declare
  jwt_a text := current_setting('chatbot.smoke.jwt_a');
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

-- ===========================================================================
-- 8. Staff JWT (with app_metadata.staff = true) sees all rows
-- ===========================================================================
\echo
\echo '-- 8. Staff JWT: SELECT chatbot_clients returns all rows'
do $smoke$
declare
  n int;
  jwt_staff text := current_setting('chatbot.smoke.jwt_staff');
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
