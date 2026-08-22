-- WP-XX — Phase 2 of "multiple web projects per client". WebBrief moves
-- from 1:1-per-client to 1:1-per-project (ClientProduct row). Also adds
-- WebBriefAudit (mirrors WebQuoteAudit) so brief edits are auditable.
--
-- Backfill: today's data is 100% single-web-row-per-client (multiplicity
-- doesn't exist yet until Phase 3), so every existing WebBrief maps
-- unambiguously to its client's single 'web' ClientProduct row.

ALTER TABLE "WebBrief" ADD COLUMN "client_product_id" UUID;

UPDATE "WebBrief" wb
SET "client_product_id" = cp."id"
FROM "ClientProduct" cp
JOIN "Product" p ON p."id" = cp."product_id"
WHERE cp."client_id" = wb."client_id" AND p."code" = 'web';

-- Any WebBrief row that couldn't be backfilled (no matching 'web'
-- ClientProduct — shouldn't happen, since the brief route already
-- requires an active/quote_pending/paused 'web' row to write one) would
-- fail the NOT NULL below loudly rather than silently orphaning data.
ALTER TABLE "WebBrief" ALTER COLUMN "client_product_id" SET NOT NULL;

DROP INDEX "WebBrief_client_id_key";
CREATE UNIQUE INDEX "WebBrief_client_product_id_key" ON "WebBrief"("client_product_id");
CREATE INDEX "WebBrief_client_id_idx" ON "WebBrief"("client_id");

ALTER TABLE "WebBrief"
    ADD CONSTRAINT "WebBrief_client_product_id_fkey"
    FOREIGN KEY ("client_product_id") REFERENCES "ClientProduct"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "WebBriefAudit" (
    "id" UUID NOT NULL,
    "web_brief_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "actor_type" TEXT NOT NULL DEFAULT 'client',
    "actor_email" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebBriefAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WebBriefAudit_web_brief_id_idx" ON "WebBriefAudit"("web_brief_id");
CREATE INDEX "WebBriefAudit_created_at_idx" ON "WebBriefAudit"("created_at");

ALTER TABLE "WebBriefAudit"
    ADD CONSTRAINT "WebBriefAudit_web_brief_id_fkey"
    FOREIGN KEY ("web_brief_id") REFERENCES "WebBrief"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
