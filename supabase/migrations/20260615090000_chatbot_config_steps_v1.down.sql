-- 20260615090000_chatbot_config_steps_v1.down.sql
-- Rollback for the v1 chatbot config steps migration.
-- Drops both tables, the updated_at trigger, and the helper functions.
-- SAFE on staging: drops only the objects created by the up migration.
-- The v0 tables (chatbot_wizard_step_data + chatbot_wizard_reviews) are
-- NOT touched — they stay intact for the v0 /admin/portal/wizard/:clientId/:step
-- controller until the Frontend migrates to the v1 endpoints.

begin;

-- RLS policies (dropped automatically by CASCADE, but explicit is safer)
drop policy if exists chatbot_config_steps_select_own on public.chatbot_config_steps;
drop policy if exists chatbot_config_steps_select_staff on public.chatbot_config_steps;
drop policy if exists chatbot_config_step_audits_select_own on public.chatbot_config_step_audits;
drop policy if exists chatbot_config_step_audits_select_staff on public.chatbot_config_step_audits;

-- Helper functions
drop function if exists public.latest_approved_version(uuid, text);
drop function if exists public.is_step_approved(uuid, text);

-- Trigger + trigger function
drop trigger if exists trg_chatbot_config_steps_touch_updated_at on public.chatbot_config_steps;
drop function if exists public.chatbot_config_steps_touch_updated_at();

-- Indexes (dropped automatically by CASCADE on DROP TABLE, but explicit)
drop index if exists chatbot_config_steps_client_step_key_version_udx;
drop index if exists chatbot_config_steps_active_udx;
drop index if exists chatbot_config_steps_client_id_status_idx;
drop index if exists chatbot_config_steps_client_id_step_key_active_idx;
drop index if exists chatbot_config_step_audits_step_id_idx;
drop index if exists chatbot_config_step_audits_step_id_created_at_idx;
drop index if exists chatbot_config_step_audits_client_id_idx;
drop index if exists chatbot_config_step_audits_actor_idx;
drop index if exists chatbot_config_step_audits_action_idx;

-- Tables (order matters: audits first due to FK to steps)
drop table if exists public.chatbot_config_step_audits cascade;
drop table if exists public.chatbot_config_steps cascade;

-- Revoke grants (cleanup; dropped tables make these no-ops but explicit)
revoke all on public.chatbot_config_steps       from public;
revoke all on public.chatbot_config_step_audits from public;
revoke all on function public.latest_approved_version(uuid, text) from public;
revoke all on function public.is_step_approved(uuid, text) from public;

commit;
