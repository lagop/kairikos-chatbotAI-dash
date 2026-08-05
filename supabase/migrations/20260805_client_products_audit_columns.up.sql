-- 20260805_client_products_audit_columns.up.sql
-- KAIA-10783 (F3 L4): Add missing audit columns to client_products.
--
-- The Supabase migration 20260724_tenant_isolation_v1.up.sql §4 created
-- client_products with only: id, client_id, product_id, status, subscribed_at,
-- cancelled_at. The Prisma model ClientProduct also defines:
--   tenantId  String?  @map("tenant_id") @db.Uuid
--   createdBy String?  @map("created_by")
--   changedBy String?  @map("changed_by")
--   changedAt DateTime @default(now()) @map("changed_at")
--
-- Symptom (after fixing the CUID→UUID clientId bug): HTTP 500 from
-- checkout-session with "column changed_at does not exist" (and similarly
-- for tenant_id, created_by, changed_by on subsequent calls).
--
-- Reversibility: see 20260805_client_products_audit_columns.down.sql

begin;

alter table public.client_products
  add column if not exists tenant_id  uuid,
  add column if not exists created_by text,
  add column if not exists changed_by text,
  add column if not exists changed_at timestamptz not null default now();

create index if not exists client_products_tenant_id_idx
  on public.client_products (tenant_id)
  where tenant_id is not null;

commit;
