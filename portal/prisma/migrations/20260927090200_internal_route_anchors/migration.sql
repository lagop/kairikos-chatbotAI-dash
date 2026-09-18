-- Fase 1 multi-instancia, migración 3 de 4 — las tres anclas de las rutas
-- internas.
--
-- Las 36 rutas de /api/internal/* nunca toman el cliente del cuerpo de la
-- petición (aceptar un clientId del llamante permitiría escribir en cualquier
-- tenant): lo resuelven desde un identificador externo. Al mirarlas una a una
-- resultó que todas pasan por SOLO TRES tablas:
--
--   MetaChannelConnection   phone_number_id / page id / ig_user_id   12 rutas
--   TelegramConnection      bot id                                    4 rutas
--   ChatbotConversation     conversationId                            5 rutas
--
-- (RecallSubscription ya lleva client_product_id UNIQUE desde su fase. Las
-- seis rutas que resuelven por ChatbotClient son de ámbito de cliente y no
-- cambian.)
--
-- Con estas tres columnas, cada ruta interna obtiene TAMBIÉN la instancia del
-- mismo findFirst que ya hacía. Es lo que convierte "revisar 36 resoluciones"
-- en "añadir un campo al select" cuando cada producto se convierta.
--
-- Nullable: en la fase 1 nadie las lee todavía, y el chatbot sigue siendo de
-- una instancia por cliente hasta la fase 5.
--
-- OJO con los nombres de columna. MetaChannelConnection y TelegramConnection
-- son modelos nuevos y usan snake_case; ChatbotConversation es de los
-- ANTIGUOS y su columna de cliente es literalmente "clientId". La columna que
-- se añade aquí sí va en snake_case en las tres, porque así la declara el
-- @map del esquema.

ALTER TABLE "MetaChannelConnection" ADD COLUMN "client_product_id" UUID;
ALTER TABLE "TelegramConnection"    ADD COLUMN "client_product_id" UUID;
ALTER TABLE "ChatbotConversation"   ADD COLUMN "client_product_id" UUID;

CREATE INDEX "MetaChannelConnection_client_product_id_idx"
    ON "MetaChannelConnection" ("client_product_id");
CREATE INDEX "TelegramConnection_client_product_id_idx"
    ON "TelegramConnection" ("client_product_id");
CREATE INDEX "ChatbotConversation_client_product_id_idx"
    ON "ChatbotConversation" ("client_product_id");

-- Claves ajenas declaradas TAMBIÉN en el esquema (relación clientProduct en
-- cada ancla). Si vivieran solo aquí, Prisma no las conocería y un
-- `migrate diff` futuro intentaría borrarlas.
--
-- SET NULL y no CASCADE: una contratación no se borra nunca en este código
-- (se cancela, cambiando status), pero si algún día se borrara, llevarse por
-- delante el histórico de conversaciones sería mucho peor que dejar la
-- columna a NULL.
ALTER TABLE "MetaChannelConnection"
    ADD CONSTRAINT "MetaChannelConnection_client_product_id_fkey"
    FOREIGN KEY ("client_product_id") REFERENCES "ClientProduct"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TelegramConnection"
    ADD CONSTRAINT "TelegramConnection_client_product_id_fkey"
    FOREIGN KEY ("client_product_id") REFERENCES "ClientProduct"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ChatbotConversation"
    ADD CONSTRAINT "ChatbotConversation_client_product_id_fkey"
    FOREIGN KEY ("client_product_id") REFERENCES "ClientProduct"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
