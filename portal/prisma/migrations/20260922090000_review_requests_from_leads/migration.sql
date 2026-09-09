-- Fase 5 — invitaciones a reseñar a partir de los leads convertidos.
--
-- Aditiva: no cambia ni una fila existente. La maquinaria de campañas
-- (ReviewRequestCampaign / ReviewRequest / el enlace /r/{id}) ya era
-- agnóstica de canal y de origen, así que esto añade una TERCERA fuente
-- de destinatarios —después del formulario manual y de 'recall'— en vez
-- de un sistema paralelo.

-- El interruptor, por ubicación. Apagado por defecto: aquí se escribe a
-- los clientes finales del cliente, con su nombre.
ALTER TABLE "GoogleBusinessConnection"
    ADD COLUMN "auto_request_from_leads" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "auto_request_from_leads_changed_by" TEXT,
    ADD COLUMN "auto_request_from_leads_changed_at" TIMESTAMP(3);

-- Intento único por lead. NULL = el barrido todavía no lo ha mirado.
ALTER TABLE "Lead"
    ADD COLUMN "review_requested_at" TIMESTAMP(3);

-- La deduplicación ENTRE campañas no tenía ningún índice que usar: la
-- unicidad existente es (campaign_id, recipient), es decir, por campaña.
CREATE INDEX "ReviewRequest_recipient_idx" ON "ReviewRequest"("recipient");
