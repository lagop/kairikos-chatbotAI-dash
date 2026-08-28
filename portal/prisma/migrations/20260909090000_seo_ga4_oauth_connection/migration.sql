-- SEO con IA — GA4/Analytics OAuth connection, deferido de la Fase B.
-- Cliente OAuth propio, separado del de Search Console. Ver el
-- comentario del modelo en schema.prisma.

CREATE TABLE "GoogleAnalyticsConnection" (
    "id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "google_account_email" TEXT,
    "property_id" TEXT,
    "property_display_name" TEXT,
    "refresh_token_ciphertext" BYTEA NOT NULL,
    "refresh_token_iv" BYTEA NOT NULL,
    "refresh_token_tag" BYTEA NOT NULL,
    "scopes" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'pending_property_selection',
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_sync_at" TIMESTAMP(3),
    "last_sync_error" TEXT,

    CONSTRAINT "GoogleAnalyticsConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GoogleAnalyticsConnection_client_id_key" ON "GoogleAnalyticsConnection"("client_id");
CREATE INDEX "GoogleAnalyticsConnection_tenant_id_idx" ON "GoogleAnalyticsConnection"("tenant_id");
CREATE INDEX "GoogleAnalyticsConnection_status_idx" ON "GoogleAnalyticsConnection"("status");

ALTER TABLE "GoogleAnalyticsConnection"
    ADD CONSTRAINT "GoogleAnalyticsConnection_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GoogleAnalyticsConnection"
    ADD CONSTRAINT "GoogleAnalyticsConnection_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
