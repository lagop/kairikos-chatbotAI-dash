-- Rollback for 20260901130000_web_brief_per_project. Safe only if no
-- client has ever acquired a second 'web' ClientProduct row (Phase 3),
-- since restoring UNIQUE(client_id) would otherwise fail.

DROP TABLE IF EXISTS "WebBriefAudit";

ALTER TABLE "WebBrief" DROP CONSTRAINT IF EXISTS "WebBrief_client_product_id_fkey";
DROP INDEX IF EXISTS "WebBrief_client_id_idx";
DROP INDEX IF EXISTS "WebBrief_client_product_id_key";
ALTER TABLE "WebBrief" DROP COLUMN IF EXISTS "client_product_id";
CREATE UNIQUE INDEX "WebBrief_client_id_key" ON "WebBrief"("client_id");
