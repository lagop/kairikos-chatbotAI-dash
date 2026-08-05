-- 20260805_chatbot_client_tenant_id.up.sql
-- Kairikos — KAIA-10776: Add missing tenantId column to PascalCase ChatbotClient
--
-- Root cause: portal/prisma/schema.prisma:73 declares:
--   tenantId  String?  @map("tenant_id") @db.Uuid
-- on model ChatbotClient, which maps to the PascalCase "ChatbotClient" table.
-- The table was created by 20260616180000_reconcile_staging_schema.up.sql (KAIA-1570)
-- without this column. The newer 20260724_tenant_isolation_v1.up.sql (KAIA-4258)
-- only added tenant_id to the snake_case public.chatbot_clients, not to
-- "ChatbotClient".
--
-- Symptom: POST /api/public/billing/checkout-session 500s with:
--   Invalid `prisma.chatbotClient.findFirst()` invocation:
--   The column `ChatbotClient.tenantId` does not exist in the current database.
--
-- Fix: Add the column (uuid, nullable, no FK — ChatbotClient is portal-only).
-- Backfill existing rows with the default tenant so queries succeed.
--
-- Reversibility: see 20260805_chatbot_client_tenant_id.down.sql

begin;

-- Add tenant_id column — matches @map("tenant_id") in schema.prisma
alter table "ChatbotClient"
  add column if not exists tenant_id uuid;

-- Index for tenant-scoped queries (mirrors @@index([tenantId]) in schema.prisma)
create index if not exists "ChatbotClient_tenant_id_idx"
  on "ChatbotClient" (tenant_id);

-- Backfill: set tenant_id = default tenant for all existing rows
do $$
declare
  v_tenant_id uuid;
begin
  select id into v_tenant_id from public.tenants where slug = 'default' limit 1;
  if v_tenant_id is not null then
    update "ChatbotClient" set tenant_id = v_tenant_id where tenant_id is null;
  end if;
end $$;

commit;
