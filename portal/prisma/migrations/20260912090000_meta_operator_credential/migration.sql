-- Migration: operator-managed Meta app credentials, saved through
-- /admin/portal/settings/meta instead of only ever being set via
-- META_APP_ID/META_APP_SECRET/META_CONFIG_ID/META_COEXISTENCE_CONFIG_ID
-- on the VPS .env. See prisma/schema.prisma's MetaOperatorCredential
-- model comment for the full design rationale (same shape as
-- TwilioOperatorCredential, four fields instead of two).

CREATE TABLE "MetaOperatorCredential" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "app_id" TEXT,
    "app_secret_ciphertext" BYTEA,
    "app_secret_iv" BYTEA,
    "app_secret_tag" BYTEA,
    "app_secret_last_four" TEXT,
    "config_id" TEXT,
    "coexistence_config_id" TEXT,
    "saved_at" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "MetaOperatorCredential_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MetaCredentialAudit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "actor_operator_id" UUID,
    "actor_email" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "MetaCredentialAudit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MetaCredentialAudit_actor_operator_id_fkey"
        FOREIGN KEY ("actor_operator_id") REFERENCES "Operator"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "MetaCredentialAudit_created_at_idx" ON "MetaCredentialAudit"("created_at");
