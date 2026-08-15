-- Rollback: removes custom-quote billing for 'web'. Safe as a direct
-- DROP/column-drop while no WebQuote or manually-marked Invoice row has
-- been written yet. If any exist, this destroys their manual-payment
-- audit trail (channel/reference/who marked it).

ALTER TABLE "Invoice" DROP CONSTRAINT IF EXISTS "Invoice_marked_paid_by_operator_id_fkey";
ALTER TABLE "Invoice" DROP COLUMN IF EXISTS "payment_channel";
ALTER TABLE "Invoice" DROP COLUMN IF EXISTS "payment_reference";
ALTER TABLE "Invoice" DROP COLUMN IF EXISTS "paid_out_of_band";
ALTER TABLE "Invoice" DROP COLUMN IF EXISTS "marked_paid_by_operator_id";
ALTER TABLE "Invoice" DROP COLUMN IF EXISTS "marked_paid_at";

DROP TABLE IF EXISTS "WebQuoteAudit";
DROP TABLE IF EXISTS "WebQuote";
