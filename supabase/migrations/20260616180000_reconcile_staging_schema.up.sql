-- =============================================================================
-- KAIA-1570 — Reconcile staging Supabase schema with portal Prisma schema.
--
-- Lens: incremental delivery + MTTD/MTTR. We ship the smallest additive
-- change that makes the live DB match the portal Prisma schema, so the
-- QA smokes for KAIA-1254 / 1255 / 1256 / 1257 / 1258 can finally run.
--
-- Strategy: Path A (additive, non-destructive). The live DB at
-- https://supabase.com/dashboard/project/ikexqreuvoqwvwopftkt has 3
-- Supabase-managed snake_case tables (chatbot_clients, chatbot_client_users,
-- chatbot_activity) that the BOTPRESS side of the stack uses. The portal
-- Prisma client (KAIA-752) reads and writes a SEPARATE set of tables with
-- PascalCase names and camelCase columns, derived from
-- portal/prisma/schema.prisma. The 13 Prisma migrations under
-- portal/prisma/migrations/* were never applied to the live DB (the agent
-- runtime can't reach db.ikexqreuvoqwvwopftkt.supabase.co:5432 — see
-- KAIA-1435, KAIA-1472). This script materializes every portal Prisma
-- table that doesn't already exist, idempotently, in dependency order.
--
-- Why we DON'T touch the Supabase snake_case tables:
--   * They are owned by the Botpress/supabase side. Renaming or
--     column-mapping them would break the chatbot platform.
--   * The portal Prisma client never queries them. It talks to
--     "ChatbotClient", "ChatbotClientUser", "Operator", etc. (PascalCase
--     identifiers, double-quoted in the generated SQL).
--   * Per the project boundary rule: this script is the portal's
--     responsibility, not the chatbot platform's. We do not rebase the
--     Supabase schema on top of Prisma.
--
-- Idempotency: every CREATE uses IF NOT EXISTS / DO block guards. The
-- script is safe to re-run if a previous run was interrupted. It will
-- NOT drop, rename, or alter any pre-existing object. Any error
-- (e.g. a column already exists with a different type) aborts the
-- transaction; re-application is safe because every operation is
-- additive.
--
-- Rollback: see 20260616180000_reconcile_staging_schema.down.sql. The
-- rollback drops the tables in reverse dependency order. It is
-- non-destructive to the Supabase snake_case tables and to any
-- pre-existing portal Prisma rows.
--
-- Apply via: Supabase SQL editor
--   https://supabase.com/dashboard/project/ikexqreuvoqwvwopftkt/sql
-- Verify via: the queries in STAGING.md § "Post-reconcile verification".
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. ChatbotClient — source of truth for tier / goLiveAt / supabaseClientId.
--    (mirrors portal/prisma/migrations/20260609170828_init + 20260609200000
--     + 20260612150000)
-- ---------------------------------------------------------------------------
create table if not exists "ChatbotClient" (
  "id"               text          primary key,
  "email"            text          not null,
  "name"             text          not null,
  "companyName"      text,
  "tier"             text          not null default 'starter',
  "stripeCustomerId" text,
  "state"            text          not null default 'in-progress',
  "goLiveAt"         timestamp(3),
  "supabaseClientId" text,
  "createdAt"        timestamp(3)  not null default current_timestamp,
  "updatedAt"        timestamp(3)  not null default current_timestamp,

  constraint "ChatbotClient_email_key"            unique ("email"),
  constraint "ChatbotClient_supabaseClientId_key" unique ("supabaseClientId")
);

create index if not exists "ChatbotClient_stripeCustomerId_idx" on "ChatbotClient" ("stripeCustomerId");
create index if not exists "ChatbotClient_tier_idx"             on "ChatbotClient" ("tier");
create index if not exists "ChatbotClient_state_idx"            on "ChatbotClient" ("state");

-- ---------------------------------------------------------------------------
-- 2. ChatbotClientUser — NextAuth session email → clientId (1:1 in v1).
--    (mirrors portal/prisma/migrations/20260609170828_init)
-- ---------------------------------------------------------------------------
create table if not exists "ChatbotClientUser" (
  "id"            text not null primary key,
  "clientId"      text not null,
  "nextAuthEmail" text not null,

  constraint "ChatbotClientUser_nextAuthEmail_key" unique ("nextAuthEmail"),
  constraint "ChatbotClientUser_clientId_fkey"
    foreign key ("clientId") references "ChatbotClient"("id")
    on delete cascade on update cascade
);

create index if not exists "ChatbotClientUser_clientId_idx" on "ChatbotClientUser" ("clientId");

-- ---------------------------------------------------------------------------
-- 3. ChatbotActivity — T+N timeline rows, idempotent on (clientId, milestone).
--    (mirrors portal/prisma/migrations/20260609170828_init + 20260609195500)
-- ---------------------------------------------------------------------------
create table if not exists "ChatbotActivity" (
  "id"          text         not null primary key,
  "clientId"    text         not null,
  "milestone"   text         not null,
  "completedAt" timestamp(3),
  "notes"       text,

  constraint "ChatbotActivity_clientId_milestone_key" unique ("clientId", "milestone"),
  constraint "ChatbotActivity_clientId_fkey"
    foreign key ("clientId") references "ChatbotClient"("id")
    on delete cascade on update cascade
);

create index if not exists "ChatbotActivity_clientId_completedAt_idx"
  on "ChatbotActivity" ("clientId", "completedAt");

-- ---------------------------------------------------------------------------
-- 4. ChatbotConversation — read-only on portal in v1.
--    (mirrors portal/prisma/migrations/20260609170828_init)
-- ---------------------------------------------------------------------------
create table if not exists "ChatbotConversation" (
  "id"         text         not null primary key,
  "clientId"   text         not null,
  "startedAt"  timestamp(3) not null,
  "duration"   integer,
  "outcome"    text,
  "transcript" jsonb,

  constraint "ChatbotConversation_clientId_fkey"
    foreign key ("clientId") references "ChatbotClient"("id")
    on delete cascade on update cascade
);

create index if not exists "ChatbotConversation_clientId_startedAt_idx"
  on "ChatbotConversation" ("clientId", "startedAt");
create index if not exists "ChatbotConversation_clientId_outcome_idx"
  on "ChatbotConversation" ("clientId", "outcome");

-- ---------------------------------------------------------------------------
-- 5. Account / Session / VerificationToken — NextAuth v5 adapter.
--    JWT session strategy means Session is unused at runtime, but the
--    adapter still requires the model. VerificationToken is the magic-link
--    hot path. (mirrors portal/prisma/migrations/20260609194500_nextauth_tables)
-- ---------------------------------------------------------------------------
create table if not exists "Account" (
  "id"                text not null primary key,
  "userId"            text not null,
  "type"              text not null,
  "provider"          text not null,
  "providerAccountId" text not null,
  "refresh_token"     text,
  "access_token"      text,
  "expires_at"        integer,
  "token_type"        text,
  "scope"             text,
  "id_token"          text,
  "session_state"     text,

  constraint "Account_provider_providerAccountId_key" unique ("provider", "providerAccountId")
);

create index if not exists "Account_userId_idx" on "Account" ("userId");

create table if not exists "Session" (
  "id"           text         not null primary key,
  "sessionToken" text         not null,
  "userId"       text         not null,
  "expires"      timestamp(3) not null,

  constraint "Session_sessionToken_key" unique ("sessionToken")
);

create index if not exists "Session_userId_idx" on "Session" ("userId");

create table if not exists "VerificationToken" (
  "identifier" text         not null,
  "token"      text         not null,
  "expires"    timestamp(3) not null,

  constraint "VerificationToken_token_key"           unique ("token"),
  constraint "VerificationToken_identifier_token_key" unique ("identifier", "token")
);

-- ---------------------------------------------------------------------------
-- 6. OperatorNotification — sticky dedup table for /api/internal/notify-operator.
--    (mirrors portal/prisma/migrations/20260612140000_operator_notification_table
--     + 20260613124100_operator_notification_step_dedup)
-- ---------------------------------------------------------------------------
create table if not exists "OperatorNotification" (
  "id"              text         not null primary key,
  "clientId"        text,
  "kind"            text         not null,
  "day"             text         not null,
  "subject"         text         not null,
  "context"         text,
  "resendMessageId" text,
  "sentAt"          timestamp(3) not null default current_timestamp,
  "createdAt"       timestamp(3) not null default current_timestamp,
  "updatedAt"       timestamp(3) not null default current_timestamp,
  "stepId"          text,

  constraint "OperatorNotification_clientId_kind_day_key"
    unique ("clientId", "kind", "day")
);

create unique index if not exists "OperatorNotification_stepId_kind_day_key"
  on "OperatorNotification" ("stepId", "kind", "day")
  where "stepId" is not null;

create index if not exists "OperatorNotification_day_idx"             on "OperatorNotification" ("day");
create index if not exists "OperatorNotification_resendMessageId_idx" on "OperatorNotification" ("resendMessageId");
create index if not exists "OperatorNotification_stepId_idx"          on "OperatorNotification" ("stepId");
create index if not exists "OperatorNotification_stepId_kind_day_idx"  on "OperatorNotification" ("stepId", "kind", "day");

-- ---------------------------------------------------------------------------
-- 7. N8nExecution — n8n flow-health dashboard backing store.
--    (mirrors portal/prisma/migrations/20260612160000_n8n_execution_table)
-- ---------------------------------------------------------------------------
create table if not exists "N8nExecution" (
  "id"           text         not null primary key,
  "clientId"     text,
  "clientName"   text,
  "workflow"     text         not null,
  "milestone"    text,
  "status"       text         not null,
  "startedAt"    timestamptz  not null,
  "finishedAt"   timestamptz,
  "errorCode"    text,
  "errorMessage" text,
  "createdAt"    timestamptz  not null default now(),

  constraint "N8nExecution_clientId_fkey"
    foreign key ("clientId") references "ChatbotClient"("id")
    on delete set null on update cascade
);

create index if not exists "N8nExecution_clientId_startedAt_idx"
  on "N8nExecution" ("clientId", "startedAt" desc);
create index if not exists "N8nExecution_status_startedAt_idx"
  on "N8nExecution" ("status", "startedAt" desc);

-- ---------------------------------------------------------------------------
-- 8. OperatorSettings + OperatorSettingsAudit — tool-integration settings
--    (KAIA-1106). Secret values are NEVER stored here — only the 1Password
--    reference. (mirrors portal/prisma/migrations/20260613090000)
-- ---------------------------------------------------------------------------
create table if not exists "OperatorSettings" (
  "id"                   uuid         not null primary key,
  "toolKey"              text         not null,
  "displayName"          text         not null,
  "category"             text         not null,
  "envVarName"           text,
  "secretManagerRef"     text         not null,
  "lastRotatedAt"        timestamptz,
  "lastHealthCheckAt"    timestamptz,
  "lastHealthStatus"     text         not null default 'unknown',
  "rotationReminderDays" integer      not null default 90,
  "notes"                text,
  "createdAt"            timestamptz  not null default now(),
  "updatedAt"            timestamptz  not null default now(),

  constraint "OperatorSettings_toolKey_key" unique ("toolKey")
);

create index if not exists "OperatorSettings_category_idx"
  on "OperatorSettings" ("category");
create index if not exists "OperatorSettings_lastHealthStatus_lastHealthCheckAt_idx"
  on "OperatorSettings" ("lastHealthStatus", "lastHealthCheckAt");

create table if not exists "OperatorSettingsAudit" (
  "id"              uuid         not null primary key,
  "settingsId"      uuid         not null,
  "actorOperatorId" uuid,
  "actorEmail"      text,
  "action"          text         not null,
  "before"          jsonb,
  "after"           jsonb,
  "metadata"        jsonb,
  "createdAt"       timestamptz  not null default now(),

  constraint "OperatorSettingsAudit_settingsId_fkey"
    foreign key ("settingsId") references "OperatorSettings"("id")
    on delete cascade on update cascade
);

create index if not exists "OperatorSettingsAudit_settingsId_idx" on "OperatorSettingsAudit" ("settingsId");
create index if not exists "OperatorSettingsAudit_action_idx"     on "OperatorSettingsAudit" ("action");
create index if not exists "OperatorSettingsAudit_createdAt_idx"  on "OperatorSettingsAudit" ("createdAt");

-- ---------------------------------------------------------------------------
-- 9. Operator + OperatorSession + OperatorRecoveryCode — per-operator
--    identity (KAIA-1107). Server-side sessions, argon2id passwords, TOTP MFA.
--    (mirrors portal/prisma/migrations/20260613103000_operator_identity_tables)
-- ---------------------------------------------------------------------------
create table if not exists "Operator" (
  "id"             uuid         not null primary key,
  "email"          text         not null,
  "passwordHash"   text         not null,
  "totpSecret"     text,
  "totpEnrolledAt" timestamptz,
  "isActive"       boolean      not null default true,
  "lastLoginAt"    timestamptz,
  "lastTotpAt"     timestamptz,
  "createdAt"      timestamptz  not null default now(),
  "updatedAt"      timestamptz  not null default now(),

  constraint "Operator_email_key" unique ("email")
);

create index if not exists "Operator_isActive_idx" on "Operator" ("isActive");

create table if not exists "OperatorSession" (
  "id"             uuid         not null primary key,
  "operatorId"     uuid         not null,
  "totpVerifiedAt" timestamptz,
  "createdAt"      timestamptz  not null default now(),
  "lastUsedAt"     timestamptz  not null default now(),
  "expiresAt"      timestamptz  not null,
  "ip"             text,
  "userAgent"      text,
  "revokedAt"      timestamptz,

  constraint "OperatorSession_operatorId_fkey"
    foreign key ("operatorId") references "Operator"("id")
    on delete cascade on update cascade
);

create index if not exists "OperatorSession_operatorId_idx" on "OperatorSession" ("operatorId");
create index if not exists "OperatorSession_expiresAt_idx"  on "OperatorSession" ("expiresAt");

create table if not exists "OperatorRecoveryCode" (
  "id"         uuid         not null primary key,
  "operatorId" uuid         not null,
  "codeHash"   text         not null,
  "consumedAt" timestamptz,
  "createdAt"  timestamptz  not null default now(),

  constraint "OperatorRecoveryCode_operatorId_fkey"
    foreign key ("operatorId") references "Operator"("id")
    on delete cascade on update cascade
);

create index if not exists "OperatorRecoveryCode_operatorId_idx" on "OperatorRecoveryCode" ("operatorId");

-- ---------------------------------------------------------------------------
-- 10. ChatbotConfigStep + ChatbotConfigStepAudit — wizard v1 step rows +
--     append-only audit log. (mirrors
--     portal/prisma/migrations/20260613110000_chatbot_config_step_table
--     + 20260615010000_chatbot_config_step_v1_addendum)
-- ---------------------------------------------------------------------------
create table if not exists "ChatbotConfigStep" (
  "id"                   text         not null primary key,
  "clientId"             text         not null,
  "stepKey"              text         not null,
  "version"              integer      not null default 1,
  "status"               text         not null default 'draft',
  "payload"              jsonb,
  "submittedAt"          timestamptz,
  "approvedAt"           timestamptz,
  "approvedByOperatorId" uuid,
  "activeForBot"         boolean      not null default false,
  "revisionComment"      text,
  "createdAt"            timestamptz  not null default now(),
  "updatedAt"            timestamptz  not null default now(),

  constraint "ChatbotConfigStep_clientId_fkey"
    foreign key ("clientId") references "ChatbotClient"("id")
    on delete cascade on update cascade,
  constraint "ChatbotConfigStep_approvedByOperatorId_fkey"
    foreign key ("approvedByOperatorId") references "Operator"("id")
    on delete set null on update cascade
);

create unique index if not exists "ChatbotConfigStep_clientId_stepKey_version_key"
  on "ChatbotConfigStep" ("clientId", "stepKey", "version");
create unique index if not exists "ChatbotConfigStep_activeForBot_partial_uniq"
  on "ChatbotConfigStep" ("clientId", "stepKey")
  where "activeForBot" = true;
create index if not exists "ChatbotConfigStep_clientId_stepKey_idx"
  on "ChatbotConfigStep" ("clientId", "stepKey");
create index if not exists "ChatbotConfigStep_clientId_stepKey_activeForBot_idx"
  on "ChatbotConfigStep" ("clientId", "stepKey", "activeForBot");
create index if not exists "ChatbotConfigStep_clientId_status_idx"
  on "ChatbotConfigStep" ("clientId", "status");

create table if not exists "ChatbotConfigStepAudit" (
  "id"        text         not null primary key,
  "stepId"    text         not null,
  "version"   integer      not null,
  "actor"     text         not null,
  "actorId"   text,
  "action"    text         not null,
  "comment"   text,
  "createdAt" timestamptz  not null default now(),

  constraint "ChatbotConfigStepAudit_stepId_fkey"
    foreign key ("stepId") references "ChatbotConfigStep"("id")
    on delete cascade on update cascade
);

create index if not exists "ChatbotConfigStepAudit_stepId_idx"          on "ChatbotConfigStepAudit" ("stepId");
create index if not exists "ChatbotConfigStepAudit_stepId_createdAt_idx" on "ChatbotConfigStepAudit" ("stepId", "createdAt");
create index if not exists "ChatbotConfigStepAudit_actor_idx"           on "ChatbotConfigStepAudit" ("actor");
create index if not exists "ChatbotConfigStepAudit_action_idx"          on "ChatbotConfigStepAudit" ("action");

-- ---------------------------------------------------------------------------
-- 11. Lifecycle helper functions (KAIA-1177). Replace-or-create guards
--     because the previous migrations use CREATE OR REPLACE FUNCTION.
--     (mirrors portal/prisma/migrations/20260613123901_lifecycle_triggers_sql_functions)
-- ---------------------------------------------------------------------------
create or replace function public.business_hours_elapsed(
  start_ts timestamptz,
  end_ts   timestamptz,
  tz       text
)
returns numeric
language plpgsql
immutable
as $$
declare
  start_local timestamp;
  end_local   timestamp;
  start_date  date;
  end_date    date;
  cursor_date date;
  day_start   timestamp;
  day_end     timestamp;
  total_hours numeric := 0;
  is_weekday  boolean;
begin
  if start_ts >= end_ts then
    return 0;
  end if;

  start_local := start_ts at time zone tz;
  end_local   := end_ts   at time zone tz;
  start_date  := start_local::date;
  end_date    := end_local::date;

  if start_date = end_date then
    is_weekday := extract(isodow from start_date) between 1 and 5;
    if is_weekday then
      day_start := start_date::timestamp + time '09:00';
      day_end   := start_date::timestamp + time '18:00';
      if end_local > day_start and start_local < day_end then
        total_hours := total_hours
          + extract(epoch from (least(end_local, day_end) - greatest(start_local, day_start))) / 3600.0;
      end if;
    end if;
    return total_hours;
  end if;

  is_weekday := extract(isodow from start_date) between 1 and 5;
  if is_weekday then
    day_start := start_date::timestamp + time '09:00';
    day_end   := start_date::timestamp + time '18:00';
    if start_local < day_end then
      total_hours := total_hours
        + extract(epoch from (day_end - greatest(start_local, day_start))) / 3600.0;
    end if;
  end if;

  cursor_date := start_date + 1;
  while cursor_date < end_date loop
    is_weekday := extract(isodow from cursor_date) between 1 and 5;
    if is_weekday then
      total_hours := total_hours + 9;
    end if;
    cursor_date := cursor_date + 1;
  end loop;

  is_weekday := extract(isodow from end_date) between 1 and 5;
  if is_weekday then
    day_start := end_date::timestamp + time '09:00';
    day_end   := end_date::timestamp + time '18:00';
    if end_local > day_start and end_local < day_end then
      total_hours := total_hours
        + extract(epoch from (least(end_local, day_end) - day_start)) / 3600.0;
    end if;
  end if;

  return total_hours;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_proc
    where proname = 'business_hours_elapsed'
      and pronamespace = 'public'::regnamespace
  ) then
    revoke all on function public.business_hours_elapsed(timestamptz, timestamptz, text) from public;
    grant execute on function public.business_hours_elapsed(timestamptz, timestamptz, text) to authenticated, service_role;
  end if;
end $$;

create or replace function public.operator_day_in_tz(
  now_ts timestamptz,
  tz     text
)
returns text
language sql
immutable
as $$
  select to_char(now_ts at time zone tz, 'YYYY-MM-DD');
$$;

do $$
begin
  if not exists (
    select 1 from pg_proc
    where proname = 'operator_day_in_tz'
      and pronamespace = 'public'::regnamespace
  ) then
    revoke all on function public.operator_day_in_tz(timestamptz, text) from public;
    grant execute on function public.operator_day_in_tz(timestamptz, text) to authenticated, service_role;
  end if;
end $$;

create or replace function public.wizard_abandoned_window(
  now_ts       timestamptz,
  window_hours integer
)
returns timestamptz
language sql
immutable
as $$
  select now_ts - (window_hours::text || ' hours')::interval;
$$;

do $$
begin
  if not exists (
    select 1 from pg_proc
    where proname = 'wizard_abandoned_window'
      and pronamespace = 'public'::regnamespace
  ) then
    revoke all on function public.wizard_abandoned_window(timestamptz, integer) from public;
    grant execute on function public.wizard_abandoned_window(timestamptz, integer) to authenticated, service_role;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 12. Document the v1 enum extension on ChatbotClient.state. The values
--     are enforced server-side; the COMMENT is documentary only. Matches
--     portal/prisma/migrations/20260615010000_chatbot_config_step_v1_addendum.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'ChatbotClient'
      and column_name  = 'state'
  ) then
    execute $sql$
      comment on column "ChatbotClient"."state" is
        'Onboarding state machine. Allowed values: '
        '  in-progress  — default for newly created clients (KAIA-1062). '
        '  go-live-pending — client clicked "I''m ready for go-live" (KAIA-1062). '
        '  live         — operator confirmed go-live; goLiveAt is also set (KAIA-1062). '
        '  ready        — wizard v1: every mandatory step reached approved for the '
        '                 first time. n8n listens for the config_complete trigger. '
        '  updating     — wizard v1: a step moved to needs_revision (or a new draft '
        '                 was created) while the client was live. The bot keeps '
        '                 running on the last approved version per step until the '
        '                 operator approves the new one. '
        'Enforced server-side; the route layer is the only writer.'
    $sql$;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 13. RLS grants: the existing 20260609_1200_002_enable_rls_chatbot_portal
--     migration enables RLS only on the snake_case Supabase tables. The
--     portal Prisma client connects with the Supabase service_role key
--     (server-only), so it bypasses RLS. We DO NOT enable RLS on the
--     PascalCase tables — that would break the magic-link signin flow,
--     which uses the anon key on the client side. The portal route
--     handlers (which DO have service_role access) are the only writers.
-- ---------------------------------------------------------------------------
-- (intentionally a no-op, documented here for the next reader)

commit;
