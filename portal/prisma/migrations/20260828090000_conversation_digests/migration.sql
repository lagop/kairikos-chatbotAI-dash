-- Migration: Canales Fase 7 — resúmenes periódicos de conversaciones
--
-- Dos tablas nuevas, sin ninguna dependencia de n8n (a diferencia de las
-- de conexión de canales): se apoyan en ChatbotConversation.transcript,
-- que el portal ya lee hoy (ver /api/portal/conversations).
--
--   ConversationDigest         — un resumen persistido por ventana de
--                                 tiempo. total/escalated/fallback count
--                                 son agregados baratos y deterministas
--                                 sobre `outcome`; summary_text/highlights
--                                 vienen de conversation-summary-ai.ts.
--   ConversationDigestSchedule — un schedule por cliente (unique en
--                                 client_id, no una fila por franja
--                                 horaria). preset 'morning_noon_evening'
--                                 usa horas fijas en código
--                                 (conversation-digest.ts); 'custom_interval'
--                                 usa interval_hours.
--
-- Nombrado "ConversationDigest", no "ConversationSummary" — ese nombre
-- ya lo usa src/types/portal.ts para el tipo de una fila del listado de
-- conversaciones (id/startedAt/durationSeconds/outcome/channel), forma
-- completamente distinta.
--
-- client_id sin @db.Uuid porque ChatbotClient.id es un cuid() TEXT, como
-- en el resto del schema. Reversibilidad: ver rollback.sql, DROP directo
-- de ambas tablas — seguro mientras no exista ningún schedule/digest
-- creado (estado esperado justo después de que esta migración aterrice).

CREATE TABLE "ConversationDigest" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "window_start" TIMESTAMP(3) NOT NULL,
    "window_end" TIMESTAMP(3) NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "total_conversations" INTEGER NOT NULL,
    "escalated_count" INTEGER NOT NULL,
    "fallback_count" INTEGER NOT NULL,
    "summary_text" TEXT NOT NULL,
    "highlights" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "ConversationDigest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ConversationDigestSchedule" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "preset" TEXT NOT NULL DEFAULT 'morning_noon_evening',
    "interval_hours" INTEGER,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Madrid',
    "last_generated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationDigestSchedule_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ConversationDigest"
    ADD CONSTRAINT "ConversationDigest_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConversationDigest"
    ADD CONSTRAINT "ConversationDigest_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ConversationDigestSchedule"
    ADD CONSTRAINT "ConversationDigestSchedule_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConversationDigestSchedule"
    ADD CONSTRAINT "ConversationDigestSchedule_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ConversationDigest_client_id_window_end_idx" ON "ConversationDigest"("client_id", "window_end");
CREATE INDEX "ConversationDigest_tenant_id_idx" ON "ConversationDigest"("tenant_id");

CREATE UNIQUE INDEX "ConversationDigestSchedule_client_id_key" ON "ConversationDigestSchedule"("client_id");
CREATE INDEX "ConversationDigestSchedule_tenant_id_idx" ON "ConversationDigestSchedule"("tenant_id");
