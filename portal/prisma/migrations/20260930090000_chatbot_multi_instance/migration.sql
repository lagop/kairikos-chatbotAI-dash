-- Fase 4 multi-instancia — un chatbot por negocio del cliente.
--
-- La última conversión, y la más profunda: del chatbot cuelgan sus pasos de
-- configuración, su base de conocimiento, sus canales, sus conversaciones y
-- sus resúmenes. La fase 1 ya dejó puestas dos de las piezas
-- (ChatbotConversation y MetaChannelConnection, las anclas desde las que
-- /api/internal/* resuelve de quién es un mensaje entrante); aquí van las
-- demás.
--
-- Y una restricción de una línea que era, literalmente, lo único que impedía
-- todo esto por Telegram: TelegramConnection estaba @@unique([client_id]).
--
-- A DIFERENCIA DE LAS FASES ANTERIORES, estas tablas SÍ tienen filas (en
-- local; producción sigue vacía). Así que aquí no vale el atajo de la columna
-- NOT NULL directa: se añade nullable, se rellena, y se deja nullable a
-- propósito — ver el punto 4.

-- 1. Las columnas.
ALTER TABLE "ChatbotConfigStep"          ADD COLUMN "client_product_id" UUID;
ALTER TABLE "ChatbotActivity"            ADD COLUMN "client_product_id" UUID;
ALTER TABLE "ChatbotKnowledgeDocument"   ADD COLUMN "client_product_id" UUID;
ALTER TABLE "ChatbotKnowledgeChunk"      ADD COLUMN "client_product_id" UUID;
ALTER TABLE "ChatWebEmbed"               ADD COLUMN "client_product_id" UUID;
ALTER TABLE "ConversationDigest"         ADD COLUMN "client_product_id" UUID;
ALTER TABLE "ConversationDigestSchedule" ADD COLUMN "client_product_id" UUID;

-- 2. El backfill: cada fila a la contratación de chatbot de su cliente.
--
-- Hasta ahora había como mucho una por cliente, así que el emparejamiento es
-- exacto y no una heurística. El LIMIT 1 es defensivo: si alguna vez hubiera
-- dos, es preferible dejar la columna a NULL —la fila no se actualiza porque
-- el WHERE la excluye— que repartir al azar.
--
-- OJO con los nombres de columna: ChatbotConfigStep, ChatbotActivity y
-- ChatbotConversation son modelos ANTIGUOS y su columna de cliente es
-- literalmente "clientId"; los demás usan @map a snake_case. Comprobado
-- modelo a modelo antes de escribir esto.
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT tbl, col FROM (VALUES
            ('ChatbotConfigStep',          'clientId'),
            ('ChatbotActivity',            'clientId'),
            ('ChatbotKnowledgeDocument',   'client_id'),
            ('ChatbotKnowledgeChunk',      'client_id'),
            ('ChatWebEmbed',               'client_id'),
            ('ConversationDigest',         'client_id'),
            ('ConversationDigestSchedule', 'client_id')
        ) AS t(tbl, col)
    LOOP
        EXECUTE format(
            'UPDATE %I SET "client_product_id" = ('
            || ' SELECT cp."id" FROM "ClientProduct" cp'
            || ' JOIN "Product" p ON p."id" = cp."product_id"'
            || ' WHERE cp."client_id" = %I.%I AND p."code" = ''chatbot'''
            || '   AND cp."status" = ''active'' LIMIT 1)'
            || ' WHERE "client_product_id" IS NULL',
            r.tbl, r.tbl, r.col
        );
    END LOOP;
END $$;

-- 3. Claves ajenas e índices.
--
-- Las declara también el esquema (relación clientProduct en cada modelo); si
-- vivieran solo aquí, un `migrate diff` futuro intentaría borrarlas.
-- ChatbotKnowledgeChunk queda sin clave ajena, igual que su client_id: es una
-- columna desnormalizada del documento, para que la búsqueda de texto
-- completo filtre sin pasar por él.
ALTER TABLE "ChatbotConfigStep"
    ADD CONSTRAINT "ChatbotConfigStep_client_product_id_fkey"
    FOREIGN KEY ("client_product_id") REFERENCES "ClientProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatbotActivity"
    ADD CONSTRAINT "ChatbotActivity_client_product_id_fkey"
    FOREIGN KEY ("client_product_id") REFERENCES "ClientProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatbotKnowledgeDocument"
    ADD CONSTRAINT "ChatbotKnowledgeDocument_client_product_id_fkey"
    FOREIGN KEY ("client_product_id") REFERENCES "ClientProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatWebEmbed"
    ADD CONSTRAINT "ChatWebEmbed_client_product_id_fkey"
    FOREIGN KEY ("client_product_id") REFERENCES "ClientProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationDigest"
    ADD CONSTRAINT "ConversationDigest_client_product_id_fkey"
    FOREIGN KEY ("client_product_id") REFERENCES "ClientProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationDigestSchedule"
    ADD CONSTRAINT "ConversationDigestSchedule_client_product_id_fkey"
    FOREIGN KEY ("client_product_id") REFERENCES "ClientProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "ChatbotConfigStep_client_product_id_idx"        ON "ChatbotConfigStep" ("client_product_id");
CREATE INDEX "ChatbotActivity_client_product_id_idx"          ON "ChatbotActivity" ("client_product_id");
CREATE INDEX "ChatbotKnowledgeDocument_client_product_id_idx" ON "ChatbotKnowledgeDocument" ("client_product_id");
CREATE INDEX "ChatbotKnowledgeChunk_client_product_id_idx"    ON "ChatbotKnowledgeChunk" ("client_product_id");
CREATE INDEX "ChatWebEmbed_client_product_id_idx"             ON "ChatWebEmbed" ("client_product_id");
CREATE INDEX "ConversationDigest_client_product_id_idx"       ON "ConversationDigest" ("client_product_id");

-- 4. Las restricciones de unicidad se mudan a la contratación.
--
-- Por qué las columnas se quedan NULLABLE y no se cierran con SET NOT NULL:
-- estas tablas las escriben también caminos que pueden no conocer la
-- contratación —un mensaje entrante que llega por un canal sin chatbot
-- asignado, una fila anterior a la conversión—, y perder el dato es peor que
-- guardarlo sin atribuir. La unicidad por client_product_id es lo que impide
-- de verdad que dos chatbots se pisen; NULL simplemente queda fuera de ella,
-- que es el comportamiento correcto para una fila huérfana.
ALTER TABLE "ChatbotConfigStep" DROP CONSTRAINT IF EXISTS "ChatbotConfigStep_client_product_step_version_key";
DROP INDEX IF EXISTS "ChatbotConfigStep_client_product_step_version_key";
CREATE UNIQUE INDEX "ChatbotConfigStep_client_product_id_step_key_version_key"
    ON "ChatbotConfigStep" ("client_product_id", "stepKey", "version");

-- Y el índice único PARCIAL que impone "una sola versión activa por paso".
-- No estaba en el esquema (Prisma no sabe expresar "único donde
-- activeForBot") y por eso es fácil pasarlo por alto: sin moverlo, dos
-- chatbots del mismo cliente no podrían tener cada uno su versión activa del
-- mismo paso, y el segundo fallaría al aprobar con un error de clave
-- duplicada que no dice nada de multi-instancia.
DROP INDEX IF EXISTS "ChatbotConfigStep_activeForBot_partial_uniq";
CREATE UNIQUE INDEX "ChatbotConfigStep_activeForBot_partial_uniq"
    ON "ChatbotConfigStep" ("client_product_id", "stepKey")
    WHERE "activeForBot" = true;

ALTER TABLE "ChatbotActivity" DROP CONSTRAINT IF EXISTS "ChatbotActivity_client_product_milestone_key";
DROP INDEX IF EXISTS "ChatbotActivity_client_product_milestone_key";
CREATE UNIQUE INDEX "ChatbotActivity_client_product_id_milestone_key"
    ON "ChatbotActivity" ("client_product_id", "milestone");

-- Telegram: la línea que lo bloqueaba todo.
ALTER TABLE "TelegramConnection" DROP CONSTRAINT IF EXISTS "TelegramConnection_client_id_key";
DROP INDEX IF EXISTS "TelegramConnection_client_id_key";
CREATE UNIQUE INDEX "TelegramConnection_client_product_id_key"
    ON "TelegramConnection" ("client_product_id");

ALTER TABLE "ConversationDigestSchedule" DROP CONSTRAINT IF EXISTS "ConversationDigestSchedule_client_id_key";
DROP INDEX IF EXISTS "ConversationDigestSchedule_client_id_key";
CREATE UNIQUE INDEX "ConversationDigestSchedule_client_product_id_key"
    ON "ConversationDigestSchedule" ("client_product_id");

-- 5. Levantar la guarda para 'chatbot'.
--
-- Cuarta y última vez que se toca este índice parcial. Mismo recurso y misma
-- razón que en 20260901120000 (web), 20260928090000 (seo) y 20260929090000
-- (recall). El test tests/unit/multi-instance-products.test.ts compara esta
-- lista con MULTI_INSTANCE_PRODUCT_CODES.
DO $$
DECLARE
    excluded_ids uuid[];
BEGIN
    SELECT array_agg(id) INTO excluded_ids
    FROM "Product" WHERE code IN ('web', 'seo', 'recall', 'chatbot');

    IF excluded_ids IS NULL OR array_length(excluded_ids, 1) IS NULL THEN
        RAISE NOTICE 'Sin esos productos en el catálogo: se deja el índice como estaba.';
        RETURN;
    END IF;

    EXECUTE 'DROP INDEX IF EXISTS "ClientProduct_client_id_product_id_single_instance_key"';
    EXECUTE format(
        'CREATE UNIQUE INDEX IF NOT EXISTS %I ON "ClientProduct" ("client_id", "product_id") WHERE "product_id" <> ALL (%L::uuid[])',
        'ClientProduct_client_id_product_id_single_instance_key',
        excluded_ids
    );
END $$;
