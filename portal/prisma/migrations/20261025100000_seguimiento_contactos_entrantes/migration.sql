-- 25/10/2026 — seguimiento por correo a los contactos entrantes con
-- consentimiento comercial (lib/inbound-follow-up.ts).
--
-- Solo añade columnas que admiten nulos y una tabla nueva: no toca filas.
-- PublicDraftRequest y CalculatorLead usan snake_case en sus columnas (@map).

ALTER TABLE "PublicDraftRequest" ADD COLUMN IF NOT EXISTS "unsubscribed_at" TIMESTAMP(3);
ALTER TABLE "PublicDraftRequest" ADD COLUMN IF NOT EXISTS "unsubscribe_token" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "PublicDraftRequest_unsubscribe_token_key" ON "PublicDraftRequest"("unsubscribe_token");

ALTER TABLE "CalculatorLead" ADD COLUMN IF NOT EXISTS "unsubscribed_at" TIMESTAMP(3);
ALTER TABLE "CalculatorLead" ADD COLUMN IF NOT EXISTS "unsubscribe_token" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "CalculatorLead_unsubscribe_token_key" ON "CalculatorLead"("unsubscribe_token");

-- Una fila por correo de la secuencia. La clave única es la que impide mandar
-- dos veces el mismo paso: el barrido reserva la fila antes de enviar.
CREATE TABLE IF NOT EXISTS "InboundFollowUpEmail" (
    "id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundFollowUpEmail_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "InboundFollowUpEmail_source_source_id_step_key" ON "InboundFollowUpEmail"("source", "source_id", "step");
CREATE INDEX IF NOT EXISTS "InboundFollowUpEmail_email_idx" ON "InboundFollowUpEmail"("email");
