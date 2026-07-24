-- Rollback: Multi-tenant Phase 0 schema (KAIA-4258)
--
-- Safe to run only when no application code references the new Tenant,
-- Profile, Product, ClientProduct tables or the tenant_id columns. The
-- API refactor (KAIA-4267) currently does NOT reference these, so this
-- rollback is safe to apply right after migration.sql as part of a
-- Phase 0 rollback. Once the API refactor merges, treat tenant_id as
-- load-bearing and prefer a forward fix over rollback.
--
-- Pre-conditions before running this:
--   1. Application code is on a commit before the API refactor (KAIA-4267)
--      that resolves tenantId from Profile.
--   2. No Feature Flag store rows reference Tenant.features for the
--      multi-tenant rollout flag.
--   3. No ClientProduct rows have been written by the operator UI
--      (the backfill in migration.sql created matching rows; if any
--      post-backfill rows exist, archiving them is the safer path —
--      rename ClientProduct to ClientProduct_archived_<ts>).
--
-- Removal order: drop ClientProduct first (provides nothing else),
-- then Product (no FKs in), then Profile (FK to User only), then the
-- tenant_id columns on every existing table, then Tenant last. Drop
-- the tenant_id columns BEFORE dropping Tenant itself so the FK
-- constraints don't block.

-- =============================================================================
-- Drop ClientProduct (FKs to ChatbotClient, Product, Tenant)
-- =============================================================================
DROP INDEX IF EXISTS "ClientProduct_status_idx";
DROP INDEX IF EXISTS "ClientProduct_tenant_id_idx";
DROP INDEX IF EXISTS "ClientProduct_product_id_idx";
DROP INDEX IF EXISTS "ClientProduct_client_id_idx";

DROP TABLE IF EXISTS "ClientProduct";

-- =============================================================================
-- Drop Product
-- =============================================================================
DROP INDEX IF EXISTS "Product_is_active_idx";
DROP INDEX IF EXISTS "Product_tier_idx";

DROP TABLE IF EXISTS "Product";

-- =============================================================================
-- Drop Profile (FK to User, Tenant)
-- =============================================================================
DROP INDEX IF EXISTS "Profile_role_idx";
DROP INDEX IF EXISTS "Profile_tenant_id_idx";

DROP TABLE IF EXISTS "Profile";

-- =============================================================================
-- Drop tenant_id columns and their indexes from existing tables
-- (must happen BEFORE dropping Tenant so the FK constraints don't block)
-- =============================================================================

-- ChatbotClient
DROP INDEX IF EXISTS "ChatbotClient_tenant_id_idx";
ALTER TABLE "ChatbotClient" DROP CONSTRAINT IF EXISTS "ChatbotClient_tenant_id_fkey";
ALTER TABLE "ChatbotClient" DROP COLUMN IF EXISTS "tenant_id";

-- ChatbotClientUser
DROP INDEX IF EXISTS "ChatbotClientUser_tenant_id_idx";
ALTER TABLE "ChatbotClientUser" DROP CONSTRAINT IF EXISTS "ChatbotClientUser_tenant_id_fkey";
ALTER TABLE "ChatbotClientUser" DROP COLUMN IF EXISTS "tenant_id";

-- ChatbotActivity
DROP INDEX IF EXISTS "ChatbotActivity_tenant_id_idx";
ALTER TABLE "ChatbotActivity" DROP CONSTRAINT IF EXISTS "ChatbotActivity_tenant_id_fkey";
ALTER TABLE "ChatbotActivity" DROP COLUMN IF EXISTS "tenant_id";

-- ChatbotConversation
DROP INDEX IF EXISTS "ChatbotConversation_tenant_id_idx";
ALTER TABLE "ChatbotConversation" DROP CONSTRAINT IF EXISTS "ChatbotConversation_tenant_id_fkey";
ALTER TABLE "ChatbotConversation" DROP COLUMN IF EXISTS "tenant_id";

-- ChatbotConfigStep
DROP INDEX IF EXISTS "ChatbotConfigStep_tenant_id_idx";
ALTER TABLE "ChatbotConfigStep" DROP CONSTRAINT IF EXISTS "ChatbotConfigStep_tenant_id_fkey";
ALTER TABLE "ChatbotConfigStep" DROP COLUMN IF EXISTS "tenant_id";

-- ChatbotConfigStepAudit
DROP INDEX IF EXISTS "ChatbotConfigStepAudit_tenant_id_idx";
ALTER TABLE "ChatbotConfigStepAudit" DROP CONSTRAINT IF EXISTS "ChatbotConfigStepAudit_tenant_id_fkey";
ALTER TABLE "ChatbotConfigStepAudit" DROP COLUMN IF EXISTS "tenant_id";

-- IntakeSubmission
DROP INDEX IF EXISTS "IntakeSubmission_tenant_id_idx";
ALTER TABLE "IntakeSubmission" DROP CONSTRAINT IF EXISTS "IntakeSubmission_tenant_id_fkey";
ALTER TABLE "IntakeSubmission" DROP COLUMN IF EXISTS "tenant_id";

-- OperatorNotification
DROP INDEX IF EXISTS "OperatorNotification_tenant_id_idx";
ALTER TABLE "OperatorNotification" DROP CONSTRAINT IF EXISTS "OperatorNotification_tenant_id_fkey";
ALTER TABLE "OperatorNotification" DROP COLUMN IF EXISTS "tenant_id";

-- N8nExecution
DROP INDEX IF EXISTS "N8nExecution_tenant_id_idx";
ALTER TABLE "N8nExecution" DROP CONSTRAINT IF EXISTS "N8nExecution_tenant_id_fkey";
ALTER TABLE "N8nExecution" DROP COLUMN IF EXISTS "tenant_id";

-- =============================================================================
-- Drop Tenant last
-- =============================================================================
DROP INDEX IF EXISTS "Tenant_status_idx";
DROP INDEX IF EXISTS "Tenant_slug_idx";

DROP TABLE IF EXISTS "Tenant";
