-- Prospección con IA, Fase C — primer contacto automático por WhatsApp,
-- detrás de consentimiento explícito del cliente (ver el plan de la
-- sesión). Todas las columnas son aditivas y nullable o con default
-- seguro; ninguna fila existente cambia de comportamiento hasta que un
-- cliente marque el consentimiento explícitamente.

ALTER TABLE "ProspectingCampaign" ADD COLUMN "consent_acknowledged_at" TIMESTAMP(3);
ALTER TABLE "ProspectingCampaign" ADD COLUMN "consent_version" TEXT;
ALTER TABLE "ProspectingCampaign" ADD COLUMN "auto_contact_paused_at" TIMESTAMP(3);

ALTER TABLE "Lead" ADD COLUMN "auto_contact_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Lead" ADD COLUMN "auto_contact_error" TEXT;
