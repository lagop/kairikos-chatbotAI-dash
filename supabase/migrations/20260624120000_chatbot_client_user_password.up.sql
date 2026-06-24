-- Migration: add passwordHash to ChatbotClientUser (KAIA-2103)
ALTER TABLE "ChatbotClientUser" ADD COLUMN IF NOT EXISTS "passwordHash" TEXT;
