-- Rollback for 20260904120000_recall_digest_and_review_reminder.
--
-- Dropping RecallDigest destroys the verbatim record of what each owner
-- asked us to do — the exact thing that table exists to preserve. This is
-- for a failed deploy, not a routine revert.
DROP TABLE IF EXISTS "RecallDigest";

DROP INDEX IF EXISTS "ReviewRequest_status_sent_at_reminded_at_idx";

ALTER TABLE "ReviewRequest"
    DROP COLUMN IF EXISTS "reminded_at";
