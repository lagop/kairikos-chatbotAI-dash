-- Generic encrypted credential storage for the operator's own third-party
-- API keys (/admin/portal/settings/integrations) — first user is the
-- Google Places key for 'prospecting'. Same encrypted-in-DB pattern as
-- StripeOperatorCredential, deliberately NOT the same table as
-- OperatorSettings (that one only ever stores a 1Password reference).

CREATE TABLE "IntegrationCredential" (
    "id" UUID NOT NULL,
    "tool_key" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "secret_ciphertext" BYTEA NOT NULL,
    "secret_iv" BYTEA NOT NULL,
    "secret_tag" BYTEA NOT NULL,
    "secret_last_four" TEXT NOT NULL,
    "saved_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IntegrationCredential_tool_key_key" ON "IntegrationCredential"("tool_key");

CREATE TABLE "IntegrationCredentialAudit" (
    "id" UUID NOT NULL,
    "credential_id" UUID NOT NULL,
    "tool_key" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "actor_operator_id" UUID,
    "actor_email" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationCredentialAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "IntegrationCredentialAudit_credential_id_idx" ON "IntegrationCredentialAudit"("credential_id");
CREATE INDEX "IntegrationCredentialAudit_tool_key_idx" ON "IntegrationCredentialAudit"("tool_key");
CREATE INDEX "IntegrationCredentialAudit_created_at_idx" ON "IntegrationCredentialAudit"("created_at");

ALTER TABLE "IntegrationCredentialAudit"
    ADD CONSTRAINT "IntegrationCredentialAudit_credential_id_fkey"
    FOREIGN KEY ("credential_id") REFERENCES "IntegrationCredential"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IntegrationCredentialAudit"
    ADD CONSTRAINT "IntegrationCredentialAudit_actor_operator_id_fkey"
    FOREIGN KEY ("actor_operator_id") REFERENCES "Operator"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
