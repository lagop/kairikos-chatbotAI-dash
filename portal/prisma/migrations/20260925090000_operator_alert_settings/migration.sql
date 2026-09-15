-- Destinatarios de las alertas de operador, configurables desde
-- /admin/portal/settings/alerts. Singleton; ver el comentario del modelo
-- OperatorAlertSettings en schema.prisma.

CREATE TABLE "operator_alert_settings" (
    "id" UUID NOT NULL,
    "operator_emails" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "ceo_email" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "operator_alert_settings_pkey" PRIMARY KEY ("id")
);
