-- Rollback for 20260609194500_nextauth_tables
-- KAIA-753 — drop the NextAuth adapter tables. Order matters: drop indexes
-- by virtue of dropping the tables. VerificationToken is the magic-link
-- hot path; dropping it invalidates in-flight links.

DROP INDEX IF EXISTS "VerificationToken_identifier_token_key";
DROP INDEX IF EXISTS "VerificationToken_token_key";
DROP INDEX IF EXISTS "Session_userId_idx";
DROP INDEX IF EXISTS "Session_sessionToken_key";
DROP INDEX IF EXISTS "Account_userId_idx";
DROP INDEX IF EXISTS "Account_provider_providerAccountId_key";

DROP TABLE IF EXISTS "VerificationToken";
DROP TABLE IF EXISTS "Session";
DROP TABLE IF EXISTS "Account";
