-- Fase 3 — bandeja de traspaso a humano.
--
-- Aditiva y nullable. OJO: ChatbotConversation es un modelo ANTIGUO y NO
-- mapea sus columnas a snake_case — su clave es "clientId", no "client_id"
-- (por eso el índice de abajo lleva las comillas tal cual). Las columnas
-- nuevas sí van en snake_case, con @map en el esquema, igual que
-- "leads_classified_at" y "external_session_id".
--
-- El backfill marca como pendientes las conversaciones que YA estaban
-- derivadas: existen desde antes de que hubiera bandeja y son justamente
-- las que nadie ha atendido. Se usa "startedAt" como momento de la
-- derivación porque es lo único que se sabe — no se guardaba cuándo
-- escaló. Es una aproximación, y por eso se hace aquí de una vez y no en
-- código que tendría que arrastrar la excepción para siempre.

ALTER TABLE "ChatbotConversation" ADD COLUMN "handoff_requested_at" TIMESTAMP(3);
ALTER TABLE "ChatbotConversation" ADD COLUMN "handoff_taken_at" TIMESTAMP(3);
ALTER TABLE "ChatbotConversation" ADD COLUMN "handoff_taken_by" TEXT;
ALTER TABLE "ChatbotConversation" ADD COLUMN "handoff_closed_at" TIMESTAMP(3);

UPDATE "ChatbotConversation"
   SET "handoff_requested_at" = "startedAt"
 WHERE "outcome" = 'escalated';

CREATE INDEX "ChatbotConversation_clientId_handoff_requested_at_idx"
    ON "ChatbotConversation"("clientId", "handoff_requested_at");
