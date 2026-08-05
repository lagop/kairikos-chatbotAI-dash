-- 20260805_client_products_audit_columns.down.sql
-- Reversal of 20260805_client_products_audit_columns.up.sql

begin;

drop index if exists public.client_products_tenant_id_idx;

alter table public.client_products
  drop column if exists tenant_id,
  drop column if exists created_by,
  drop column if exists changed_by,
  drop column if exists changed_at;

commit;
