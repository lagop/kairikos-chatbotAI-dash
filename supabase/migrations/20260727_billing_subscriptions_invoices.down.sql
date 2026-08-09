-- 20260727_billing_subscriptions_invoices.down.sql
-- Rollback for the Supabase mirror of the KAIA-4262 billing tables.

begin;

-- ---------------------------------------------------------------------------
-- Drop order: child tables first (no inbound FKs), then the parent,
-- then the webhook events log (no FKs, last), then the Tenant column.
-- ---------------------------------------------------------------------------

-- invoices (FK in from this table only — drop first)
drop trigger if exists invoices_set_updated_at on public.invoices;
drop policy if exists invoices_select_tenant on public.invoices;
drop policy if exists invoices_modify_service_role on public.invoices;
drop index if exists invoices_status_idx;
drop index if exists invoices_subscription_id_idx;
drop index if exists invoices_client_id_idx;
drop index if exists invoices_tenant_id_idx;
drop table if exists public.invoices;

-- subscriptions (FK in from invoices via the cascade; already dropped above)
drop trigger if exists subscriptions_set_updated_at on public.subscriptions;
drop policy if exists subscriptions_select_tenant on public.subscriptions;
drop policy if exists subscriptions_modify_service_role on public.subscriptions;
drop index if exists subscriptions_stripe_customer_id_idx;
drop index if exists subscriptions_status_idx;
drop index if exists subscriptions_client_id_idx;
drop index if exists subscriptions_tenant_id_idx;
drop table if exists public.subscriptions;

-- stripe_webhook_events (no FKs)
drop policy if exists stripe_webhook_events_select_service_role on public.stripe_webhook_events;
drop policy if exists stripe_webhook_events_modify_service_role on public.stripe_webhook_events;
drop index if exists stripe_webhook_events_received_at_idx;
drop index if exists stripe_webhook_events_status_idx;
drop table if exists public.stripe_webhook_events;

-- tenants.stripe_customer_id
drop index if exists tenants_stripe_customer_id_key;
alter table public.tenants drop column if exists stripe_customer_id;

commit;
