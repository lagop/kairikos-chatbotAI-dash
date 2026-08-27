-- SEO con IA, Fase B — Search Console OAuth connection (ver el plan de la
-- sesion). Un cliente OAuth propio, separado del de GoogleBusinessConnection.

CREATE TABLE "GoogleSeoConnection" (
    "id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "google_account_email" TEXT,
    "search_console_site_url" TEXT NOT NULL,
    "refresh_token_ciphertext" BYTEA NOT NULL,
    "refresh_token_iv" BYTEA NOT NULL,
    "refresh_token_tag" BYTEA NOT NULL,
    "scopes" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_sync_at" TIMESTAMP(3),
    "last_sync_error" TEXT,

    CONSTRAINT "GoogleSeoConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GoogleSeoConnection_client_id_key" ON "GoogleSeoConnection"("client_id");
CREATE INDEX "GoogleSeoConnection_tenant_id_idx" ON "GoogleSeoConnection"("tenant_id");
CREATE INDEX "GoogleSeoConnection_status_idx" ON "GoogleSeoConnection"("status");

ALTER TABLE "GoogleSeoConnection"
    ADD CONSTRAINT "GoogleSeoConnection_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GoogleSeoConnection"
    ADD CONSTRAINT "GoogleSeoConnection_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
