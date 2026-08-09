-- Migration: add password reset token table for client users (KAIA-2103)
-- Supports forgot-password + reset-password flow via time-limited tokens.

CREATE TABLE IF NOT EXISTS "PasswordResetToken" (
  "id"          TEXT        NOT NULL PRIMARY KEY DEFAULT cuid(),
  "email"       TEXT        NOT NULL,
  "tokenHash"   TEXT        NOT NULL,
  "expiresAt"   TIMESTAMPTZ NOT NULL,
  "usedAt"      TIMESTAMPTZ,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "PasswordResetToken_email_idx" ON "PasswordResetToken"("email");
CREATE INDEX IF NOT EXISTS "PasswordResetToken_tokenHash_idx" ON "PasswordResetToken"("tokenHash");
