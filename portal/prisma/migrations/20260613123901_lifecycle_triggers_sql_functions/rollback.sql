-- Rollback for KAIA-1177 lifecycle-trigger SQL functions.
-- Drops the three functions added in the forward migration.
-- Safe: nothing else in the schema depends on them yet.

drop function if exists public.business_hours_elapsed(timestamptz, timestamptz, text);
drop function if exists public.operator_day_in_tz(timestamptz, text);
drop function if exists public.wizard_abandoned_window(timestamptz, integer);
