-- Migration: WP-21 — conexión OAuth y almacenamiento cifrado de credenciales
--
-- New table GoogleBusinessConnection: one row per client Google Business
-- Profile location connected via OAuth (WP-22 syncs/replies to its
-- reviews). Deliberately separate from any existing Google integration —
-- the refresh token is encrypted at rest (AES-256-GCM, three separate
-- Bytes columns: ciphertext/iv/tag, never a single opaque blob) with its
-- own dedicated key (GOOGLE_TOKEN_ENCRYPTION_KEY, see
-- lib/operator-crypto.ts), distinct from the key guarding operator TOTP
-- secrets.
--
-- client_id has no FK to ChatbotClient here at the SQL level for the same
-- reason ChatbotConfigStep etc. don't either in this schema's existing
-- convention — but this table DOES declare the FK (unlike some legacy
-- tables), matching every model introduced since WP-12's ClientProduct.
--
-- Reversibility: see rollback.sql — a straight DROP TABLE, safe as long
-- as no connection has been created yet (the expected state immediately
-- after this migration lands).

CREATE TABLE "GoogleBusinessConnection" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "google_account_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "location_name" TEXT NOT NULL,
    "refresh_token_ciphertext" BYTEA NOT NULL,
    "refresh_token_iv" BYTEA NOT NULL,
    "refresh_token_tag" BYTEA NOT NULL,
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_sync_at" TIMESTAMP(3),
    "last_sync_error" TEXT,

    CONSTRAINT "GoogleBusinessConnection_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "GoogleBusinessConnection"
    ADD CONSTRAINT "GoogleBusinessConnection_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GoogleBusinessConnection"
    ADD CONSTRAINT "GoogleBusinessConnection_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "GoogleBusinessConnection_client_id_location_id_key"
    ON "GoogleBusinessConnection"("client_id", "location_id");

CREATE INDEX "GoogleBusinessConnection_tenant_id_idx" ON "GoogleBusinessConnection"("tenant_id");
CREATE INDEX "GoogleBusinessConnection_status_idx" ON "GoogleBusinessConnection"("status");
