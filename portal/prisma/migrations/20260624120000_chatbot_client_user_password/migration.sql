-- Migration: add passwordHash to ChatbotClientUser (KAIA-2103)
-- Switches client login from magic-link to email+password credentials.
-- Nullable so existing rows are unaffected; passwords are set via admin tooling.

ALTER TABLE "ChatbotClientUser" ADD COLUMN "passwordHash" TEXT;
