-- =============================================================================
-- WP-09 audit — run against PRODUCTION before applying 02-migration.sql.
--
-- Read-only. Run with a role that can SELECT the tables below (does not
-- need write access). Paste the output into the WP-09 PR/ticket before
-- anyone runs the migration.
--
-- Context: 20260724130000_multi_tenant_phase0 added a nullable tenant_id
-- to every client-scoped table and backfilled existing rows to a single
-- 'default' Tenant, planning to flip the column to NOT NULL "after the
-- rollout completes" — but no application write path was ever updated to
-- actually populate tenant_id on INSERT, so new rows kept landing with
-- tenant_id = NULL right alongside the pre-migration legacy rows. The
-- application fix (this same WP-09 PR, portal/src/lib/tenant.ts and its
-- call sites) stops new NULLs from this point forward; this audit is
-- about the rows that already exist.
--
-- Two groups, different expectations:
--
--   GROUP A — always client-scoped. Every row should end up with a
--   non-null tenant_id once 02-migration.sql's one-time backfill runs.
--   These are the tables 02-migration.sql adds a NOT NULL constraint to.
--
--   GROUP B — legitimately nullable. IntakeSubmission / OperatorNotification
--   / N8nExecution can represent a TRUE global/unassigned event with no
--   client_id (e.g. a global n8n failure notification) — tenant_id is
--   NULL by design for those rows, not a gap. 02-migration.sql does NOT
--   touch these tables. Listed here only so the count isn't mistaken for
--   an oversight; there's nothing to action unless total_null is
--   surprisingly close to total_rows (which would suggest client_id
--   itself is rarely being set, a different problem).
-- =============================================================================

-- ---- GROUP A: must reach 0 before applying 02-migration.sql ----------------
SELECT 'ChatbotClient'          AS table_name, COUNT(*) AS total_rows, COUNT(*) FILTER (WHERE tenant_id IS NULL) AS null_tenant_id FROM "ChatbotClient"
UNION ALL
SELECT 'ChatbotClientUser',            COUNT(*), COUNT(*) FILTER (WHERE tenant_id IS NULL) FROM "ChatbotClientUser"
UNION ALL
SELECT 'ChatbotActivity',              COUNT(*), COUNT(*) FILTER (WHERE tenant_id IS NULL) FROM "ChatbotActivity"
UNION ALL
SELECT 'ChatbotConversation',          COUNT(*), COUNT(*) FILTER (WHERE tenant_id IS NULL) FROM "ChatbotConversation"
UNION ALL
SELECT 'ChatbotConfigStep',            COUNT(*), COUNT(*) FILTER (WHERE tenant_id IS NULL) FROM "ChatbotConfigStep"
UNION ALL
SELECT 'ChatbotConfigStepAudit',       COUNT(*), COUNT(*) FILTER (WHERE tenant_id IS NULL) FROM "ChatbotConfigStepAudit"
UNION ALL
SELECT 'ClientProduct',                COUNT(*), COUNT(*) FILTER (WHERE tenant_id IS NULL) FROM "ClientProduct"
UNION ALL
SELECT 'ClientProductAudit',           COUNT(*), COUNT(*) FILTER (WHERE tenant_id IS NULL) FROM "ClientProductAudit"
ORDER BY table_name;

-- ---- GROUP B: informational only — NULLs here are expected -----------------
SELECT 'IntakeSubmission (Group B)'       AS table_name, COUNT(*) AS total_rows, COUNT(*) FILTER (WHERE tenant_id IS NULL) AS null_tenant_id, COUNT(*) FILTER (WHERE tenant_id IS NULL AND client_id IS NOT NULL) AS null_tenant_id_with_client FROM "IntakeSubmission"
UNION ALL
SELECT 'OperatorNotification (Group B)',        COUNT(*), COUNT(*) FILTER (WHERE tenant_id IS NULL), COUNT(*) FILTER (WHERE tenant_id IS NULL AND "clientId" IS NOT NULL) FROM "OperatorNotification"
UNION ALL
SELECT 'N8nExecution (Group B)',                COUNT(*), COUNT(*) FILTER (WHERE tenant_id IS NULL), COUNT(*) FILTER (WHERE tenant_id IS NULL AND "clientId" IS NOT NULL) FROM "N8nExecution"
ORDER BY table_name;

-- A non-zero `null_tenant_id_with_client` count in Group B is worth a look
-- (unlike a bare null_tenant_id, which is expected for the truly global
-- rows): it means a row that DID have a client attached still didn't get
-- a tenant_id, which 02-migration.sql's backfill also covers, but is
-- worth understanding before running it — it means those specific write
-- paths (help-request notify, wizard-abandoned notify, n8n activity
-- ingestion, etc.) had the same "never set tenant_id" gap this PR is
-- closing for the Group A tables.

-- ---- Sanity: how many distinct tenants actually exist today? ---------------
-- If this returns exactly 1 row (slug='default'), every Group A NULL can
-- be safely backfilled to DEFAULT_TENANT_ID by 02-migration.sql. If it
-- returns more than 1, STOP — some ChatbotClient rows may legitimately
-- belong to a non-default tenant, and a blanket "NULL -> default" backfill
-- would silently misassign them. Investigate per-tenant NULL counts
-- (join ChatbotClient on tenant_id) before proceeding.
SELECT id, slug, name, status FROM "Tenant" ORDER BY created_at;
