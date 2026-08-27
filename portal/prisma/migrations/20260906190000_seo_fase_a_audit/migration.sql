-- SEO con IA, Fase A — the operator-triggered technical audit. Latest
-- result only, stored on SeoProfile itself (no history table yet).

ALTER TABLE "SeoProfile" ADD COLUMN "last_audit_at" TIMESTAMP(3);
ALTER TABLE "SeoProfile" ADD COLUMN "last_audit_result" JSONB;
ALTER TABLE "SeoProfile" ADD COLUMN "last_audit_error" TEXT;
