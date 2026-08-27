-- SEO con IA, Fase A — onboarding (ver el plan de la sesión). SeoProfile
-- es un formulario simple, no el motor de wizard: cliente y operador
-- escriben columnas distintas de la misma fila (mismo patrón que
-- RecallSubscription).

CREATE TABLE "SeoProfile" (
    "id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_product_id" UUID NOT NULL,
    "tenant_id" UUID,
    "business_description" TEXT,
    "target_audience" TEXT,
    "tone_of_voice" TEXT,
    "site_url" TEXT,
    "cms_type" TEXT,
    "wordpress_url" TEXT,
    "wordpress_username" TEXT,
    "wordpress_app_password_ciphertext" BYTEA,
    "wordpress_app_password_iv" BYTEA,
    "wordpress_app_password_tag" BYTEA,
    "technical_setup_notes" TEXT,
    "technical_setup_completed_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'onboarding',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeoProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SeoProfile_client_product_id_key" ON "SeoProfile"("client_product_id");
CREATE INDEX "SeoProfile_client_id_idx" ON "SeoProfile"("client_id");
CREATE INDEX "SeoProfile_tenant_id_idx" ON "SeoProfile"("tenant_id");
CREATE INDEX "SeoProfile_status_idx" ON "SeoProfile"("status");

ALTER TABLE "SeoProfile"
    ADD CONSTRAINT "SeoProfile_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SeoProfile"
    ADD CONSTRAINT "SeoProfile_client_product_id_fkey"
    FOREIGN KEY ("client_product_id") REFERENCES "ClientProduct"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SeoProfile"
    ADD CONSTRAINT "SeoProfile_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "SeoProfileAudit" (
    "id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "actor_type" TEXT NOT NULL DEFAULT 'client',
    "actor_operator_id" UUID,
    "actor_email" TEXT,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeoProfileAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SeoProfileAudit_profile_id_changed_at_idx" ON "SeoProfileAudit"("profile_id", "changed_at");
CREATE INDEX "SeoProfileAudit_client_id_changed_at_idx" ON "SeoProfileAudit"("client_id", "changed_at");
CREATE INDEX "SeoProfileAudit_tenant_id_idx" ON "SeoProfileAudit"("tenant_id");

ALTER TABLE "SeoProfileAudit"
    ADD CONSTRAINT "SeoProfileAudit_profile_id_fkey"
    FOREIGN KEY ("profile_id") REFERENCES "SeoProfile"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SeoProfileAudit"
    ADD CONSTRAINT "SeoProfileAudit_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SeoProfileAudit"
    ADD CONSTRAINT "SeoProfileAudit_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SeoProfileAudit"
    ADD CONSTRAINT "SeoProfileAudit_actor_operator_id_fkey"
    FOREIGN KEY ("actor_operator_id") REFERENCES "Operator"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
