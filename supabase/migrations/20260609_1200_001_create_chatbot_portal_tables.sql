-- 20260609_1200_001_create_chatbot_portal_tables.sql
-- Kairikos — Chatbot AI end-client portal (KAIA-731)
--
-- Creates the four core portal tables. Designed to coexist with the existing
-- Kairikos Supabase schema (no destructive changes to anything pre-existing).
--
-- Tables:
--   chatbot_clients          — one row per paying client
--   chatbot_client_users     — mapping auth.users.id -> chatbot_clients.id (v1: 1:1)
--   chatbot_activity         — timeline rows written by n8n T+N flows
--   chatbot_conversations    — chatbot conversation records (read-only on portal)
--
-- Reversibility: see supabase/migrations/20260609_1200_001_create_chatbot_portal_tables.down.sql

begin;

-- ---------------------------------------------------------------------------
-- chatbot_clients
-- ---------------------------------------------------------------------------
create table if not exists public.chatbot_clients (
  id                      uuid          primary key default gen_random_uuid(),
  -- Human-readable stable identifier exposed in URLs and support requests
  slug                    text          not null unique,
  company_name            text          not null,
  primary_contact_email   text          not null,
  -- Billing: ties the client to a Stripe customer (populated by Stripe webhooks)
  stripe_customer_id      text          unique,
  -- Subscription tier (matches Kairikos pricing tiers; source of truth for billing is Stripe)
  tier                    text          not null default 'starter'
                          check (tier in ('starter', 'pro', 'premium')),
  -- Onboarding state machine
  onboarding_status       text          not null default 'pending'
                          check (onboarding_status in (
                            'pending',         -- T+0 intake received
                            'in_progress',     -- mid-onboarding
                            'live',            -- chatbot is in production
                            'paused',
                            'cancelled'
                          )),
  -- Chatbot space identifier (set when the CTO spins up the chatbot in production)
  chatbot_space_id        text,
  go_live_at              timestamptz,
  -- Soft-delete + audit
  created_at              timestamptz   not null default now(),
  updated_at              timestamptz   not null default now(),
  deleted_at              timestamptz
);

create index if not exists chatbot_clients_stripe_customer_id_idx
  on public.chatbot_clients (stripe_customer_id)
  where stripe_customer_id is not null;

create index if not exists chatbot_clients_onboarding_status_idx
  on public.chatbot_clients (onboarding_status)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- chatbot_client_users  (auth mapping)
-- ---------------------------------------------------------------------------
-- v1 scope (per plan rev 2 §4.1): one auth.users.id maps to exactly one client.
-- The mapping is the source of truth for per-tenant RLS — every policy joins
-- through this table.
create table if not exists public.chatbot_client_users (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null references auth.users(id) on delete cascade,
  client_id     uuid        not null references public.chatbot_clients(id) on delete cascade,
  role          text        not null default 'owner'
                check (role in ('owner', 'admin', 'viewer')),
  created_at    timestamptz not null default now(),
  -- One user ↔ one client in v1. Multi-tenant org switching is explicitly out of scope
  -- (see plan rev 2 §3.3) and is a v2 backlog item.
  unique (user_id)
);

create index if not exists chatbot_client_users_client_id_idx
  on public.chatbot_client_users (client_id);

-- ---------------------------------------------------------------------------
-- chatbot_activity  (timeline rows)
-- ---------------------------------------------------------------------------
-- One row per T+N event the n8n flow emits (T+0, T+3, T+7, T+14, etc.).
-- Drives the portal onboarding timeline (plan rev 2 §3.2 item 2).
create table if not exists public.chatbot_activity (
  id            uuid        primary key default gen_random_uuid(),
  client_id     uuid        not null references public.chatbot_clients(id) on delete cascade,
  -- T+N day offset from go_live_at / intake_received_at; negative allowed for pre-onboarding
  day_offset    integer     not null,
  -- Event kind (kept as text + check constraint so n8n can extend without migrations)
  event_type    text        not null
                check (event_type in (
                  'intake_received',
                  'kickoff_scheduled',
                  'chatbot_provisioned',
                  'qa_completed',
                  'go_live',
                  't_plus_3_followup',
                  't_plus_7_followup',
                  't_plus_14_followup',
                  'support_note',
                  'billing_event'
                )),
  title         text        not null,
  body          text,
  -- Free-form metadata (JSON) for event-specific extras (e.g. QA result, transcript link)
  metadata      jsonb       not null default '{}'::jsonb,
  occurred_at   timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create index if not exists chatbot_activity_client_id_occurred_at_idx
  on public.chatbot_activity (client_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- chatbot_conversations  (read-only in portal)
-- ---------------------------------------------------------------------------
-- Source of truth for the conversations list (plan rev 2 §3.2 item 4).
-- v1: portal reads these; only service_role / n8n writes. No client-side
-- edit-in-portal (explicitly out of scope per plan rev 2 §3.3).
create table if not exists public.chatbot_conversations (
  id              uuid        primary key default gen_random_uuid(),
  client_id       uuid        not null references public.chatbot_clients(id) on delete cascade,
  -- External identifier from the chatbot platform (e.g. Botpress conversation id)
  external_id     text        not null,
  channel         text        not null default 'web'
                  check (channel in ('web', 'whatsapp', 'instagram', 'messenger', 'email', 'other')),
  started_at      timestamptz not null,
  ended_at        timestamptz,
  duration_seconds integer    check (duration_seconds is null or duration_seconds >= 0),
  -- Outcome / resolution status
  outcome         text        not null default 'unknown'
                  check (outcome in (
                    'resolved', 'escalated', 'abandoned', 'fallback', 'unknown'
                  )),
  -- Whether the bot fell back to a human
  escalated_to_human boolean  not null default false,
  -- Optional short summary or first user message (full transcript is in the chatbot platform)
  preview         text,
  created_at      timestamptz not null default now(),
  unique (client_id, external_id)
);

create index if not exists chatbot_conversations_client_id_started_at_idx
  on public.chatbot_conversations (client_id, started_at desc);

create index if not exists chatbot_conversations_client_id_outcome_idx
  on public.chatbot_conversations (client_id, outcome)
  where outcome in ('escalated', 'fallback');

-- ---------------------------------------------------------------------------
-- updated_at trigger for chatbot_clients
-- ---------------------------------------------------------------------------
create or replace function public.chatbot_clients_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_chatbot_clients_touch_updated_at on public.chatbot_clients;
create trigger trg_chatbot_clients_touch_updated_at
  before update on public.chatbot_clients
  for each row execute function public.chatbot_clients_touch_updated_at();

commit;
