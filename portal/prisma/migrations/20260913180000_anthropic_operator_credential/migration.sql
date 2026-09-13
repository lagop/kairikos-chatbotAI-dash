-- Migration: operator-managed Anthropic credential, saved through
-- /admin/portal/settings/anthropic instead of only ever being set via
-- ANTHROPIC_API_KEY on the VPS .env. See prisma/schema.prisma's
-- AnthropicOperatorCredential model comment for the full design rationale
-- (same shape as TwilioOperatorCredential: singleton, one encrypted
-- secret, the rest cleartext).
--
-- Reversible via a direct DROP while no credential row has been written
-- yet (the expected state right after this deploy, before an operator
-- has used the new settings screen).

CREATE TABLE "AnthropicOperatorCredential" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "api_key_ciphertext" BYTEA,
    "api_key_iv" BYTEA,
    "api_key_tag" BYTEA,
    "api_key_last_four" TEXT,
    "base_url" TEXT,
    "model" TEXT,
    "saved_at" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "AnthropicOperatorCredential_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AnthropicCredentialAudit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "actor_operator_id" UUID,
    "actor_email" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "AnthropicCredentialAudit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AnthropicCredentialAudit_actor_operator_id_fkey"
        FOREIGN KEY ("actor_operator_id") REFERENCES "Operator"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "AnthropicCredentialAudit_created_at_idx" ON "AnthropicCredentialAudit"("created_at");
