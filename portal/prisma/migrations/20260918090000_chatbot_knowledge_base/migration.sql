-- Fase 3 — base de conocimiento del chatbot.
--
-- Aditiva: tres tablas nuevas, ninguna columna tocada en las existentes.
--
-- OJO con los nombres de columna: ChatbotClient y ChatbotConversation son
-- modelos ANTIGUOS y no mapean a snake_case — la clave ajena de abajo
-- apunta a "ChatbotClient"("id"), y el id de ese modelo es un cuid (TEXT),
-- no un uuid. Las tablas nuevas sí usan snake_case y uuid, como el resto
-- de lo añadido este año.
--
-- La columna `search_vector` es GENERADA por Postgres a partir de
-- `content`. Se hace aquí y no en la aplicación por dos razones: no puede
-- quedar desincronizada con el texto (Postgres la recalcula en cada
-- UPDATE), y es la única forma de tener un índice GIN sobre ella, que es
-- lo que hace que la búsqueda no sea un escaneo completo.
--
-- La configuración 'spanish' no es cosmética: aplica lematización (que
-- "reservas" encuentre "reservar") y quita las palabras vacías del
-- castellano. Con 'simple' la búsqueda fallaría justo en las consultas
-- normales de un cliente español.

CREATE TABLE "ChatbotKnowledgeDocument" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "source" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "source_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "error" TEXT,
    "char_count" INTEGER NOT NULL DEFAULT 0,
    "crawled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatbotKnowledgeDocument_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChatbotKnowledgeChunk" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('spanish', "content")) STORED,

    CONSTRAINT "ChatbotKnowledgeChunk_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChatbotKnowledgeDocumentAudit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "action" TEXT NOT NULL,
    "after" JSONB,
    "actor_id" TEXT NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatbotKnowledgeDocumentAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ChatbotKnowledgeDocument_client_id_status_idx" ON "ChatbotKnowledgeDocument"("client_id", "status");
CREATE INDEX "ChatbotKnowledgeDocument_tenant_id_idx" ON "ChatbotKnowledgeDocument"("tenant_id");
CREATE INDEX "ChatbotKnowledgeChunk_client_id_idx" ON "ChatbotKnowledgeChunk"("client_id");
CREATE INDEX "ChatbotKnowledgeChunk_document_id_ordinal_idx" ON "ChatbotKnowledgeChunk"("document_id", "ordinal");
CREATE INDEX "ChatbotKnowledgeDocumentAudit_document_id_changed_at_idx" ON "ChatbotKnowledgeDocumentAudit"("document_id", "changed_at");
CREATE INDEX "ChatbotKnowledgeDocumentAudit_client_id_changed_at_idx" ON "ChatbotKnowledgeDocumentAudit"("client_id", "changed_at");
CREATE INDEX "ChatbotKnowledgeDocumentAudit_tenant_id_idx" ON "ChatbotKnowledgeDocumentAudit"("tenant_id");

-- El índice que hace que la recuperación sea viable. Sin él, cada mensaje
-- del bot provocaría un escaneo secuencial de todos los fragmentos.
CREATE INDEX "ChatbotKnowledgeChunk_search_vector_idx" ON "ChatbotKnowledgeChunk" USING GIN ("search_vector");

ALTER TABLE "ChatbotKnowledgeDocument" ADD CONSTRAINT "ChatbotKnowledgeDocument_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatbotKnowledgeDocument" ADD CONSTRAINT "ChatbotKnowledgeDocument_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ChatbotKnowledgeChunk" ADD CONSTRAINT "ChatbotKnowledgeChunk_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "ChatbotKnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatbotKnowledgeDocumentAudit" ADD CONSTRAINT "ChatbotKnowledgeDocumentAudit_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "ChatbotKnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatbotKnowledgeDocumentAudit" ADD CONSTRAINT "ChatbotKnowledgeDocumentAudit_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChatbotKnowledgeDocumentAudit" ADD CONSTRAINT "ChatbotKnowledgeDocumentAudit_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
