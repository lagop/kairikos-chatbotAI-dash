-- A5 · Leads de la calculadora de llamadas perdidas.
-- A7 · Códigos de referido y de socio, con su atribución.

CREATE TABLE IF NOT EXISTS "CalculatorLead" (
    "id" UUID NOT NULL,
    "ip_hash" TEXT NOT NULL,
    "sector" TEXT NOT NULL,
    "business_name" TEXT,
    "city" TEXT,
    "contact" TEXT NOT NULL,
    "missed_calls_per_week" INTEGER NOT NULL,
    "average_job_value_cents" INTEGER NOT NULL,
    "annual_loss_cents" INTEGER NOT NULL,
    "contacted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalculatorLead_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "CalculatorLead_created_at_idx" ON "CalculatorLead"("created_at");

-- El código no da descuento por sí mismo (eso lo siguen haciendo los cupones
-- de Stripe): responde a la única pregunta que hoy no se puede responder,
-- que es QUIÉN trajo a este cliente. Sin atribución, una comisión es una
-- discusión.
CREATE TABLE IF NOT EXISTS "ReferralCode" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "referrer_client_id" TEXT,
    "partner_name" TEXT,
    "partner_email" TEXT,
    "commission_percent" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralCode_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ReferralCode_code_key" ON "ReferralCode"("code");
CREATE INDEX IF NOT EXISTS "ReferralCode_kind_active_idx" ON "ReferralCode"("kind", "active");
ALTER TABLE "ReferralCode"
    ADD CONSTRAINT "ReferralCode_referrer_client_id_fkey"
    FOREIGN KEY ("referrer_client_id") REFERENCES "ChatbotClient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Una fila por cliente atribuido: si alguien llega dos veces con dos códigos,
-- gana el primero, que es el que de verdad lo trajo. De ahí el índice único.
CREATE TABLE IF NOT EXISTS "ReferralAttribution" (
    "id" UUID NOT NULL,
    "code_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralAttribution_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ReferralAttribution_client_id_key" ON "ReferralAttribution"("client_id");
CREATE INDEX IF NOT EXISTS "ReferralAttribution_code_id_created_at_idx"
    ON "ReferralAttribution"("code_id", "created_at");
ALTER TABLE "ReferralAttribution"
    ADD CONSTRAINT "ReferralAttribution_code_id_fkey"
    FOREIGN KEY ("code_id") REFERENCES "ReferralCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReferralAttribution"
    ADD CONSTRAINT "ReferralAttribution_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
