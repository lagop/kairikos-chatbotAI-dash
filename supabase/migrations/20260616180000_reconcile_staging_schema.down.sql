-- =============================================================================
-- KAIA-1570 — Rollback for 20260616180000_reconcile_staging_schema.up.sql.
--
-- Drops every portal Prisma table this reconcile migration created, in
-- reverse dependency order. Safe to re-run (every DROP uses IF EXISTS).
--
-- Lens: reversibility. This rollback is the inverse of the up migration —
-- the CTO/CEO can run it if a future decision lands on Path B (regenerate
-- Prisma to match the snake_case Supabase schema) or if the staging DB
-- needs a clean portal schema for a re-bootstrap.
--
-- What it does NOT touch:
--   * The Supabase snake_case tables (chatbot_clients,
--     chatbot_client_users, chatbot_activity, chatbot_conversations) —
--     owned by the Botpress/supabase side of the stack. They are
--     untouched.
--   * The Supabase-managed RLS policies and triggers from
--     20260609_1200_002_enable_rls_chatbot_portal.sql.
--   * Any rows that pre-existed in any of the portal Prisma tables —
--     CASCADE removes dependent rows, but only the ones this script
--     created in the same transaction as the table. Rows that were
--     seeded by a separate script (e.g. the operator's first
--     createSession call after the up migration) WILL be dropped.
--
-- Apply via: Supabase SQL editor
--   https://supabase.com/dashboard/project/ikexqreuvoqwvwopftkt/sql
-- Verify via: the queries in STAGING.md § "Post-rollback verification".
-- =============================================================================

begin;

-- Reverse order: tables with no inbound FKs first, then up the chain.

-- ChatbotConfigStepAudit → ChatbotConfigStep → ChatbotConfigStep.approvedByOperatorId → Operator
drop table if exists "ChatbotConfigStepAudit" cascade;

-- ChatbotConfigStep has FKs from ChatbotConfigStepAudit (dropped above) and to
-- ChatbotClient + Operator. Drop after ChatbotConfigStepAudit.
drop table if exists "ChatbotConfigStep" cascade;

-- OperatorSession / OperatorRecoveryCode → Operator. Drop dependents first.
drop table if exists "OperatorRecoveryCode" cascade;
drop table if exists "OperatorSession"   cascade;
drop table if exists "Operator"          cascade;

-- OperatorSettingsAudit → OperatorSettings. Drop audit before settings.
drop table if exists "OperatorSettingsAudit" cascade;
drop table if exists "OperatorSettings"      cascade;

-- N8nExecution → ChatbotClient (SetNull on delete, but drop with cascade to be sure).
drop table if exists "N8nExecution" cascade;

-- OperatorNotification has no FKs; safe to drop.
drop table if exists "OperatorNotification" cascade;

-- NextAuth adapter tables. Account / Session / VerificationToken are independent.
drop table if exists "VerificationToken" cascade;
drop table if exists "Session"           cascade;
drop table if exists "Account"           cascade;

-- ChatbotActivity / ChatbotConversation / ChatbotClientUser → ChatbotClient.
drop table if exists "ChatbotConversation" cascade;
drop table if exists "ChatbotActivity"     cascade;
drop table if exists "ChatbotClientUser"   cascade;

-- ChatbotClient is the root of the dependency tree; drop last among the tables.
drop table if exists "ChatbotClient" cascade;

-- Lifecycle helper functions. Use a function existence check so re-runs
-- do not raise "function does not exist" warnings.
do $$
begin
  if exists (select 1 from pg_proc where proname = 'business_hours_elapsed' and pronamespace = 'public'::regnamespace) then
    revoke all on function public.business_hours_elapsed(timestamptz, timestamptz, text) from public;
    drop function public.business_hours_elapsed(timestamptz, timestamptz, text);
  end if;
  if exists (select 1 from pg_proc where proname = 'operator_day_in_tz' and pronamespace = 'public'::regnamespace) then
    revoke all on function public.operator_day_in_tz(timestamptz, text) from public;
    drop function public.operator_day_in_tz(timestamptz, text);
  end if;
  if exists (select 1 from pg_proc where proname = 'wizard_abandoned_window' and pronamespace = 'public'::regnamespace) then
    revoke all on function public.wizard_abandoned_window(timestamptz, integer) from public;
    drop function public.wizard_abandoned_window(timestamptz, integer);
  end if;
end $$;

-- Drop the column comment on ChatbotClient.state if it still references the
-- v1 enum values. Comment removal is idempotent (COMMENT ON COLUMN ... IS NULL).
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'ChatbotClient'
      and column_name  = 'state'
  ) then
    execute 'comment on column "ChatbotClient"."state" is null';
  end if;
end $$;

commit;
