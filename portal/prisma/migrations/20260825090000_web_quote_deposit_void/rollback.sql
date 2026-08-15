-- Rollback: removes the deposit/invoice-role columns. Safe as a direct
-- column drop while no WebQuote has a depositCents value and no Invoice
-- has an invoiceRole value set yet (the expected state right after this
-- deploy) — otherwise this discards which invoices were deposits/finals
-- and which quotes had a deposit configured.

ALTER TABLE "Invoice" DROP COLUMN IF EXISTS "invoice_role";

ALTER TABLE "WebQuote" DROP COLUMN IF EXISTS "deposit_cents";
