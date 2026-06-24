-- Migration: add User table for credential-based auth (KAIA-2103)
-- Creates a unified user identity table that stores credentials (passwordHash).
-- ChatbotClientUser and Operator both reference User via userId.
-- Backfill: every ChatbotClientUser row is linked to a new User row with role='client'.

CREATE TABLE "User" (
    "id"             TEXT        NOT NULL PRIMARY KEY DEFAULT cuid(),
    "role"           TEXT        NOT NULL DEFAULT 'client',
    "email"          TEXT        NOT NULL UNIQUE,
    "passwordHash"   TEXT,
    "passwordSetAt"  TIMESTAMPTZ,
    "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX "User_email_idx"         ON "User" ("email");
CREATE INDEX "User_role_idx"          ON "User" ("role");

-- Add userId to ChatbotClientUser as a foreign key to User
ALTER TABLE "ChatbotClientUser" ADD COLUMN "userId" TEXT;

ALTER TABLE "ChatbotClientUser"
    ADD CONSTRAINT "ChatbotClientUser_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ChatbotClientUser_userId_key" ON "ChatbotClientUser" ("userId");

-- Backfill: for each ChatbotClientUser, create a User row and link them
-- Users whose passwordHash is NULL get the __must_reset__ marker so they
-- cannot log in until they complete the setup-password flow.
INSERT INTO "User" ("id", "role", "email", "passwordHash", "passwordSetAt", "createdAt", "updatedAt")
SELECT
    cuid(),
    'client',
    "nextAuthEmail",
    COALESCE("passwordHash", '__must_reset__'),
    "passwordSetAt",
    NOW(),
    NOW()
FROM "ChatbotClientUser"
WHERE "userId" IS NULL;

-- Now link the ChatbotClientUser rows to the newly created Users
UPDATE "ChatbotClientUser" ccu
SET "userId" = (
    SELECT u."id" FROM "User" u
    WHERE u."email" = ccu."nextAuthEmail" AND u."role" = 'client'
    LIMIT 1
)
WHERE ccu."userId" IS NULL;
