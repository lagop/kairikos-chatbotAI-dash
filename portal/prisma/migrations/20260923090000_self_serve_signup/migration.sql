-- WP-31: public self-serve signup + checkout (no operator involvement).
--
-- Three pieces:
--   1. ChatbotClient gains two nullable timestamps — tos_accepted_at
--      (consent capture, missing for every client created any other
--      way) and email_verified_at (see EmailVerificationToken below).
--   2. Product gains self_serve_eligible, defaulted false and backfilled
--      true only for the tiers decided in this go-live pass: every
--      billable product except 'web' (no catalog price — always sold by
--      quote, createProductCheckoutSession already rejects it
--      unconditionally) and 'recall' (holds until its own Meta
--      template / article 28 readiness gate clears — a business
--      decision, not a technical one, flip it with an UPDATE once
--      ready, no migration needed).
--   3. EmailVerificationToken — deliberately a new table, not a
--      'purpose' column on PasswordResetToken (see that model's
--      comment in schema.prisma for why: KAIA-11500 was a real
--      auth-bypass bug in that exact table).

ALTER TABLE "ChatbotClient" ADD COLUMN "tos_accepted_at" TIMESTAMPTZ;
ALTER TABLE "ChatbotClient" ADD COLUMN "email_verified_at" TIMESTAMPTZ;

ALTER TABLE "Product" ADD COLUMN "self_serve_eligible" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Product" SET "self_serve_eligible" = true WHERE "code" NOT IN ('web', 'recall');

CREATE TABLE IF NOT EXISTS "EmailVerificationToken" (
  "id"          TEXT        NOT NULL PRIMARY KEY DEFAULT cuid(),
  "email"       TEXT        NOT NULL,
  "tokenHash"   TEXT        NOT NULL,
  "expiresAt"   TIMESTAMPTZ NOT NULL,
  "usedAt"      TIMESTAMPTZ,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "EmailVerificationToken_email_idx" ON "EmailVerificationToken"("email");
CREATE INDEX IF NOT EXISTS "EmailVerificationToken_tokenHash_idx" ON "EmailVerificationToken"("tokenHash");
