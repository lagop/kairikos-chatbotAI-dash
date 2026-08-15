-- Migration: custom-quote billing for 'web' — WebQuote + WebQuoteAudit,
-- and manual-payment tracking columns on Invoice. See the model comments
-- in prisma/schema.prisma for the full design rationale.
--
-- Reversible via rollback.sql — safe as a direct DROP/column-drop while
-- no WebQuote/Invoice-manual-payment row has been written yet (the
-- expected state right after this deploy).

CREATE TABLE "WebQuote" (
    "id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_product_id" UUID NOT NULL,
    "tenant_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "amount_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'eur',
    "description" TEXT NOT NULL,
    "created_by_operator_id" UUID,
    "sent_at" TIMESTAMPTZ,
    "sent_by_operator_id" UUID,
    "accepted_at" TIMESTAMPTZ,
    "cancelled_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "WebQuote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WebQuote_client_product_id_key" ON "WebQuote"("client_product_id");
CREATE INDEX "WebQuote_client_id_idx" ON "WebQuote"("client_id");
CREATE INDEX "WebQuote_status_idx" ON "WebQuote"("status");
CREATE INDEX "WebQuote_tenant_id_idx" ON "WebQuote"("tenant_id");

ALTER TABLE "WebQuote" ADD CONSTRAINT "WebQuote_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebQuote" ADD CONSTRAINT "WebQuote_client_product_id_fkey"
    FOREIGN KEY ("client_product_id") REFERENCES "ClientProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebQuote" ADD CONSTRAINT "WebQuote_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WebQuote" ADD CONSTRAINT "WebQuote_created_by_operator_id_fkey"
    FOREIGN KEY ("created_by_operator_id") REFERENCES "Operator"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WebQuote" ADD CONSTRAINT "WebQuote_sent_by_operator_id_fkey"
    FOREIGN KEY ("sent_by_operator_id") REFERENCES "Operator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "WebQuoteAudit" (
    "id" UUID NOT NULL,
    "web_quote_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "actor_type" TEXT NOT NULL DEFAULT 'operator',
    "actor_operator_id" UUID,
    "actor_email" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "WebQuoteAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WebQuoteAudit_web_quote_id_idx" ON "WebQuoteAudit"("web_quote_id");
CREATE INDEX "WebQuoteAudit_action_idx" ON "WebQuoteAudit"("action");
CREATE INDEX "WebQuoteAudit_created_at_idx" ON "WebQuoteAudit"("created_at");

ALTER TABLE "WebQuoteAudit" ADD CONSTRAINT "WebQuoteAudit_web_quote_id_fkey"
    FOREIGN KEY ("web_quote_id") REFERENCES "WebQuote"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebQuoteAudit" ADD CONSTRAINT "WebQuoteAudit_actor_operator_id_fkey"
    FOREIGN KEY ("actor_operator_id") REFERENCES "Operator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Invoice" ADD COLUMN "payment_channel" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "payment_reference" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "paid_out_of_band" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Invoice" ADD COLUMN "marked_paid_by_operator_id" UUID;
ALTER TABLE "Invoice" ADD COLUMN "marked_paid_at" TIMESTAMPTZ;

ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_marked_paid_by_operator_id_fkey"
    FOREIGN KEY ("marked_paid_by_operator_id") REFERENCES "Operator"("id") ON DELETE SET NULL ON UPDATE CASCADE;
