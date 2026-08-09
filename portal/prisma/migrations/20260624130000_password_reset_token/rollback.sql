-- Migration rollback: drop password reset token table (KAIA-2103)
DROP TABLE IF EXISTS "PasswordResetToken";
