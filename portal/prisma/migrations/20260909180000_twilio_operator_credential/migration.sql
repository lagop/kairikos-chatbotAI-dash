-- Migration: operator-managed Twilio credentials, saved through
-- /admin/portal/settings/telephony instead of only ever being set via
-- TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN on the VPS .env. See
-- prisma/schema.prisma's TwilioOperatorCredential model comment for the
-- full design rationale (same shape as StripeOperatorCredential, minus
-- the test/live split).
--
-- Reversible via a direct DROP while no credential row has been written
-- yet (the expected state right after this deploy, before an operator
-- has used the new settings screen).

CREATE TABLE "TwilioOperatorCredential" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_sid" TEXT,
    "auth_token_ciphertext" BYTEA,
    "auth_token_iv" BYTEA,
    "auth_token_tag" BYTEA,
    "auth_token_last_four" TEXT,
    "saved_at" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "TwilioOperatorCredential_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TwilioCredentialAudit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "actor_operator_id" UUID,
    "actor_email" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "TwilioCredentialAudit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TwilioCredentialAudit_actor_operator_id_fkey"
        FOREIGN KEY ("actor_operator_id") REFERENCES "Operator"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "TwilioCredentialAudit_created_at_idx" ON "TwilioCredentialAudit"("created_at");
