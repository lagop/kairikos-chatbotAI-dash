-- supabase/seeds/chatbot_clients_seed.sql
-- Dev/QA seed: 2 fake clients (1 fully onboarded, 1 mid-onboarding).
--
-- Usage (run as service_role):
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/seeds/chatbot_clients_seed.sql
--
-- Idempotency: every insert uses ON CONFLICT ... DO NOTHING keyed on stable
-- identifiers (slug, user email, external_id), so re-running the script is safe.
--
-- IMPORTANT: This script DOES NOT create auth.users rows. Supabase auth.users
-- lives in the `auth` schema and must be created via the Supabase Auth admin
-- API or the Supabase Studio UI. The fake user UUIDs below are placeholders —
-- swap them for the real auth.users.id returned by the Auth API before
-- running this seed in staging/prod.
--
-- To run end-to-end in dev:
--   1. supabase auth admin invite --email onboarding-test1@kairikos.dev
--      → note the user UUID, set it as :'user_id_onboarded'
--   2. supabase auth admin invite --email onboarding-test2@kairikos.dev
--      → note the user UUID, set it as :'user_id_mid'
--   3. psql ... -v user_id_onboarded=... -v user_id_mid=... -f this.sql

begin;

-- ---------------------------------------------------------------------------
-- Client 1 — fully onboarded (live chatbot, all T+N events done)
-- ---------------------------------------------------------------------------
insert into public.chatbot_clients (
  id,
  slug,
  company_name,
  primary_contact_email,
  stripe_customer_id,
  tier,
  onboarding_status,
  chatbot_space_id,
  go_live_at
) values (
  '11111111-1111-1111-1111-111111111111',
  'acme-clay-ovens',
  'Acme Clay Ovens',
  'onboarding-test1@kairikos.dev',
  'cus_test_acme_ovens',
  'pro',
  'live',
  'spc_acme_prod_01',
  now() - interval '21 days'
)
on conflict (id) do nothing;

-- Client 2 — mid-onboarding (intake received, chatbot provisioned, awaiting QA)
insert into public.chatbot_clients (
  id,
  slug,
  company_name,
  primary_contact_email,
  stripe_customer_id,
  tier,
  onboarding_status,
  chatbot_space_id,
  go_live_at
) values (
  '22222222-2222-2222-2222-222222222222',
  'brisa-beach-houses',
  'Brisa Beach Houses',
  'onboarding-test2@kairikos.dev',
  'cus_test_brisa_houses',
  'starter',
  'in_progress',
  'spc_brisa_staging_01',
  null
)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Auth user mappings
-- These inserts require the auth.users rows to already exist. The script
-- uses ON CONFLICT on the unique (user_id) constraint to remain idempotent.
-- Replace the placeholder UUIDs with the real auth.users.id values before
-- running in any environment that has actual auth rows.
-- ---------------------------------------------------------------------------
insert into public.chatbot_client_users (user_id, client_id, role)
values
  ('00000000-0000-0000-0000-0000000000a1'::uuid,
   '11111111-1111-1111-1111-111111111111'::uuid,
   'owner'),
  ('00000000-0000-0000-0000-0000000000a2'::uuid,
   '22222222-2222-2222-2222-222222222222'::uuid,
   'owner')
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------------
-- Activity timeline — Client 1 (fully onboarded)
-- ---------------------------------------------------------------------------
insert into public.chatbot_activity (client_id, day_offset, event_type, title, body, occurred_at) values
  ('11111111-1111-1111-1111-111111111111'::uuid,  0, 'intake_received',     'T+0 intake received',     'Tally form submitted. Welcome email sent.',                now() - interval '21 days'),
  ('11111111-1111-1111-1111-111111111111'::uuid,  0, 'kickoff_scheduled',   'Kickoff call scheduled',  'Booked for Day 1, 10:00 CET.',                              now() - interval '20 days 23 hours'),
  ('11111111-1111-1111-1111-111111111111'::uuid,  1, 'chatbot_provisioned', 'Chatbot space provisioned', 'Botpress space spc_acme_prod_01 created and configured.', now() - interval '20 days'),
  ('11111111-1111-1111-1111-111111111111'::uuid,  5, 'qa_completed',        'QA script passed',         'All KAIA-705 §6 checks passed (auth, intents, fallback).', now() - interval '15 days'),
  ('11111111-1111-1111-1111-111111111111'::uuid,  7, 'go_live',             'Chatbot is live',          'Domain wired. First real conversation logged.',            now() - interval '14 days'),
  ('11111111-1111-1111-1111-111111111111'::uuid, 10, 't_plus_3_followup',   'T+3 follow-up',            'Client confirmed everything is working. 0 escalations.',  now() - interval '11 days'),
  ('11111111-1111-1111-1111-111111111111'::uuid, 14, 't_plus_7_followup',   'T+7 follow-up',            'Usage review: 312 conversations, 4% fallback rate.',      now() - interval '7 days')
on conflict do nothing;

-- Activity timeline — Client 2 (mid-onboarding)
insert into public.chatbot_activity (client_id, day_offset, event_type, title, body, occurred_at) values
  ('22222222-2222-2222-2222-222222222222'::uuid, 0, 'intake_received',     'T+0 intake received',     'Tally form submitted. Welcome email sent.',                now() - interval '3 days'),
  ('22222222-2222-2222-2222-222222222222'::uuid, 1, 'kickoff_scheduled',   'Kickoff call scheduled',  'Booked for Day 2, 16:00 CET.',                              now() - interval '2 days 22 hours')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Conversations — Client 1 (a few realistic rows so the portal list view has
-- something to render). 7 days of activity.
-- ---------------------------------------------------------------------------
insert into public.chatbot_conversations
  (client_id, external_id, channel, started_at, ended_at, duration_seconds, outcome, escalated_to_human, preview)
values
  ('11111111-1111-1111-1111-111111111111'::uuid, 'bp_acme_001', 'web',        now() - interval '6 days',  now() - interval '6 days' + interval '2 minutes', 120, 'resolved', false, 'Hi, what are your opening hours this week?'),
  ('11111111-1111-1111-1111-111111111111'::uuid, 'bp_acme_002', 'web',        now() - interval '5 days',  now() - interval '5 days' + interval '45 seconds', 45, 'fallback', true,  'I want to talk to a human about a custom order'),
  ('11111111-1111-1111-1111-111111111111'::uuid, 'bp_acme_003', 'whatsapp',   now() - interval '4 days',  now() - interval '4 days' + interval '5 minutes', 300, 'resolved', false, 'Do you ship to Lisbon?'),
  ('11111111-1111-1111-1111-111111111111'::uuid, 'bp_acme_004', 'web',        now() - interval '3 days',  now() - interval '3 days' + interval '1 minute',  60, 'abandoned', false, 'Can I get a refund for order #4421?'),
  ('11111111-1111-1111-1111-111111111111'::uuid, 'bp_acme_005', 'instagram',  now() - interval '1 day',   now() - interval '1 day' + interval '90 seconds',  90, 'resolved', false, 'Are the clay ovens safe for indoor use?')
on conflict (client_id, external_id) do nothing;

commit;
