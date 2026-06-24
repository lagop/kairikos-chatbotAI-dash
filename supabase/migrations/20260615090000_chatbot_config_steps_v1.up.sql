-- 20260615090000_chatbot_config_steps_v1.up.sql
-- Kairikos — Chatbot wizard configuration steps v1 (KAIA-1163 / BE-1)
--
-- Creates the chatbot_config_steps and chatbot_config_step_audits tables
-- alongside helper functions for the operator review flow.
--
-- Table: chatbot_config_steps
--   One row per (client, stepKey, version). The wizard creates version=1 on
--   first save; subsequent edits increment version. The bot always reads the
--   row where active_for_bot = true for a given (client_id, step_key).
--
-- Status lifecycle (enforced server-side):
--   draft -> submitted -> approved       (forward)
--         -> needs_revision <-            (operator can flip back)
--
-- Table: chatbot_config_step_audits
--   Immutable (append-only) audit log. One row per discrete event: edit,
--   submit, approve, request_revision, activate, deactivate.
--
-- Unique invariant:
--   Partial unique index on (client_id, step_key) WHERE active_for_bot = true
--   enforces "at most one active version per (client, step)" at the DB level.
--
-- Reversibility: see the .down.sql companion.

begin;

-- ---------------------------------------------------------------------------
-- chatbot_config_steps
-- ---------------------------------------------------------------------------
create table if not exists public.chatbot_config_steps (
  id                      uuid          primary key default gen_random_uuid(),
  client_id               uuid          not null references public.chatbot_clients(id) on delete cascade,
  -- Step identifier: "1" through "12" (Steps 1-10 + 11 Pruebas + 12 Integraciones).
  -- Enforced server-side via a per-step Zod schema registry.
  step_key                text          not null,
  -- Monotonically increasing per (client_id, step_key). Starts at 1.
  version                 integer       not null default 1,
  -- 'draft' | 'submitted' | 'approved' | 'needs_revision'. Enforced server-side.
  status                  text          not null default 'draft',
  -- Opaque JSON blob — the wizard stores the step's form fields here as a flat
  -- JSON object. v1: plaintext values. v1.1: ciphertext + envelope metadata.
  payload                 jsonb         not null default '{}'::jsonb,
  -- Set when the client clicks "Submit for review" on this step.
  submitted_at            timestamptz,
  -- Set when the operator approves this version.
  approved_at             timestamptz,
  -- Operator who approved this version (FK to operator identity, nullable until approved).
  approved_by_operator_id uuid,
  -- Exactly one row per (client_id, step_key) has active_for_bot = true at any time.
  -- The bot's config-loader reads the active version when constructing prompts.
  -- The DB-level invariant is enforced by the partial unique index below.
  active_for_bot          boolean       not null default false,
  -- Latest operator reason when the step was sent to needs_revision.
  -- Denormalized from the most recent chatbot_config_step_audits row with
  -- action = 'request_revision' so the portal GET can render the operator's
  -- note in a single round trip.
  revision_comment        text,
  created_at              timestamptz   not null default now(),
  updated_at              timestamptz   not null default now()
);

-- Unique constraint: one version per (client_id, step_key).
-- The portal enforces this at the application level via Prisma's upsert on
-- the @@unique([clientId, stepKey, version]) constraint; this index is the
-- DB-level safety net.
create unique index if not exists chatbot_config_steps_client_step_key_version_udx
  on public.chatbot_config_steps (client_id, step_key, version);

-- Partial unique index: at most one active version per (client, step).
-- This is the invariant the bot's config-loader relies on. Duplicate actives
-- raise a 23505 unique_violation in the API layer.
create unique index if not exists chatbot_config_steps_active_udx
  on public.chatbot_config_steps (client_id, step_key)
  where active_for_bot = true;

-- Query support indexes
create index if not exists chatbot_config_steps_client_id_status_idx
  on public.chatbot_config_steps (client_id, status);

create index if not exists chatbot_config_steps_client_id_step_key_active_idx
  on public.chatbot_config_steps (client_id, step_key, active_for_bot);

-- ---------------------------------------------------------------------------
-- chatbot_config_step_audits (append-only audit log)
-- ---------------------------------------------------------------------------
create table if not exists public.chatbot_config_step_audits (
  id            uuid          primary key default gen_random_uuid(),
  step_id       uuid          not null references public.chatbot_config_steps(id) on delete cascade,
  -- Denormalized client_id so the audit trail is queryable without joining.
  client_id     uuid          not null references public.chatbot_clients(id) on delete cascade,
  -- Denormalized step_key so the audit trail is readable in context.
  step_key      text          not null,
  -- Denormalized version at the time of the event so the audit trail is
  -- meaningful even if versions are later cleaned up.
  version       integer       not null,
  -- 'client' | 'operator' | 'system'. Enforced server-side.
  actor         text          not null,
  -- Email or operator UUID — whichever identifies the actor. Null for 'system' events.
  actor_id      text,
  -- 'edit' | 'submit' | 'approve' | 'request_revision' | 'activate' | 'deactivate'.
  -- Enforced server-side.
  action        text          not null,
  -- Optional free-text reason (operator's review note, system trigger name, etc.).
  comment       text,
  created_at    timestamptz   not null default now()
);

create index if not exists chatbot_config_step_audits_step_id_idx
  on public.chatbot_config_step_audits (step_id);

create index if not exists chatbot_config_step_audits_step_id_created_at_idx
  on public.chatbot_config_step_audits (step_id, created_at desc);

create index if not exists chatbot_config_step_audits_client_id_idx
  on public.chatbot_config_step_audits (client_id);

create index if not exists chatbot_config_step_audits_actor_idx
  on public.chatbot_config_step_audits (actor);

create index if not exists chatbot_config_step_audits_action_idx
  on public.chatbot_config_step_audits (action);

-- ---------------------------------------------------------------------------
-- updated_at trigger for chatbot_config_steps
-- ---------------------------------------------------------------------------
create or replace function public.chatbot_config_steps_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_chatbot_config_steps_touch_updated_at on public.chatbot_config_steps;
create trigger trg_chatbot_config_steps_touch_updated_at
  before update on public.chatbot_config_steps
  for each row execute function public.chatbot_config_steps_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------------

-- Returns the latest approved version number for a given (client, step_key),
-- or NULL if no version has been approved.
create or replace function public.latest_approved_version(
  p_client_id uuid,
  p_step_key text
)
returns integer
language sql
stable
set search_path = public
as $$
  select max(cs.version)
  from public.chatbot_config_steps cs
  where cs.client_id = p_client_id
    and cs.step_key = p_step_key
    and cs.status = 'approved'
$$;

-- Returns true if at least one version of the given (client, step_key)
-- has been approved. Useful for the tier-aware visibility layer (BE-4)
-- and for the config_complete trigger detection.
create or replace function public.is_step_approved(
  p_client_id uuid,
  p_step_key text
)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists(
    select 1
    from public.chatbot_config_steps cs
    where cs.client_id = p_client_id
      and cs.step_key = p_step_key
      and cs.status = 'approved'
  )
$$;

-- Grant execution on helper functions
revoke all on function public.latest_approved_version(uuid, text) from public;
grant execute on function public.latest_approved_version(uuid, text) to authenticated, service_role;

revoke all on function public.is_step_approved(uuid, text) from public;
grant execute on function public.is_step_approved(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS: chatbot_config_steps
-- ---------------------------------------------------------------------------
alter table public.chatbot_config_steps enable row level security;
alter table public.chatbot_config_steps force row level security;

drop policy if exists chatbot_config_steps_select_own on public.chatbot_config_steps;
create policy chatbot_config_steps_select_own
  on public.chatbot_config_steps
  for select
  to authenticated
  using (client_id = public.chatbot_current_client_id());

drop policy if exists chatbot_config_steps_select_staff on public.chatbot_config_steps;
create policy chatbot_config_steps_select_staff
  on public.chatbot_config_steps
  for select
  to authenticated
  using (public.chatbot_is_staff());

-- No insert/update/delete policies for authenticated.
-- Writes are exclusively via service_role (portal backend + n8n webhooks).

-- ---------------------------------------------------------------------------
-- RLS: chatbot_config_step_audits
-- ---------------------------------------------------------------------------
alter table public.chatbot_config_step_audits enable row level security;
alter table public.chatbot_config_step_audits force row level security;

drop policy if exists chatbot_config_step_audits_select_own on public.chatbot_config_step_audits;
create policy chatbot_config_step_audits_select_own
  on public.chatbot_config_step_audits
  for select
  to authenticated
  using (client_id = public.chatbot_current_client_id());

drop policy if exists chatbot_config_step_audits_select_staff on public.chatbot_config_step_audits;
create policy chatbot_config_step_audits_select_staff
  on public.chatbot_config_step_audits
  for select
  to authenticated
  using (public.chatbot_is_staff());

-- No insert/update/delete for authenticated.

-- ---------------------------------------------------------------------------
-- Explicit grants — keep tight
-- ---------------------------------------------------------------------------
revoke all on public.chatbot_config_steps       from public;
revoke all on public.chatbot_config_step_audits from public;

grant select on public.chatbot_config_steps       to authenticated;
grant select on public.chatbot_config_step_audits to authenticated;

grant select, insert, update, delete on public.chatbot_config_steps       to service_role;
grant select, insert, update, delete on public.chatbot_config_step_audits to service_role;

commit;
