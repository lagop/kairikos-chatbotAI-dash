-- Migration: two-part payment (deposit + final balance) and invoice
-- voiding for WebQuote. See the model comments in prisma/schema.prisma
-- for the full design rationale.
--
-- Both new columns are nullable additions with no backfill required —
-- reversible via rollback.sql as a direct column drop.

ALTER TABLE "WebQuote" ADD COLUMN "deposit_cents" INTEGER;

ALTER TABLE "Invoice" ADD COLUMN "invoice_role" TEXT;
