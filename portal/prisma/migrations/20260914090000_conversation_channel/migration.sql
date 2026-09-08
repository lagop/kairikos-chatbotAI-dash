-- Fase 1.5 — canal de origen de la conversación, para que los leads que
-- crea el clasificador dejen de salir con channel:null. Aditiva: las filas
-- existentes se quedan en NULL y todo sigue funcionando.
--
-- Ojo con el nombre de columna: ChatbotConversation es un modelo antiguo y
-- sus columnas NO están mapeadas a snake_case (es "clientId", no
-- "client_id"), a diferencia de los modelos nuevos de este repo.

ALTER TABLE "ChatbotConversation" ADD COLUMN "channel" TEXT;
