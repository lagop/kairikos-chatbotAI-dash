-- Migration: add passwordSetAt to ChatbotClientUser (KAIA-2103)
-- Tracks when the user last set or changed their password for security auditing.
ALTER TABLE "ChatbotClientUser" ADD COLUMN "passwordSetAt" TIMESTAMPTZ;
