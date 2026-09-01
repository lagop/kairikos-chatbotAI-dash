-- Moves recall's 7 WhatsApp template definitions (previously the
-- hardcoded RECALL_TEMPLATE_DEFINITIONS array in recall-templates.ts)
-- into Postgres, editable from /admin/portal/settings/recall-templates.
-- Seeded here with the EXACT current hardcoded values so behavior does
-- not change until an operator edits something.

CREATE TABLE "RecallTemplateDefinition" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "language_code" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "body_text" TEXT NOT NULL,
    "body_examples" TEXT[] NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_by_operator_id" UUID,
    "updated_by_email" TEXT,
    CONSTRAINT "RecallTemplateDefinition_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RecallTemplateDefinition_updated_by_operator_id_fkey"
        FOREIGN KEY ("updated_by_operator_id") REFERENCES "Operator"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "RecallTemplateDefinition_name_key" ON "RecallTemplateDefinition"("name");
CREATE INDEX "RecallTemplateDefinition_sort_order_idx" ON "RecallTemplateDefinition"("sort_order");

CREATE TABLE "RecallTemplateDefinitionAudit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "template_name" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "actor_operator_id" UUID,
    "actor_email" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "RecallTemplateDefinitionAudit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RecallTemplateDefinitionAudit_actor_operator_id_fkey"
        FOREIGN KEY ("actor_operator_id") REFERENCES "Operator"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "RecallTemplateDefinitionAudit_template_name_idx" ON "RecallTemplateDefinitionAudit"("template_name");
CREATE INDEX "RecallTemplateDefinitionAudit_created_at_idx" ON "RecallTemplateDefinitionAudit"("created_at");

INSERT INTO "RecallTemplateDefinition" ("name", "language_code", "category", "body_text", "body_examples", "sort_order") VALUES
('recall_caller_open', 'es', 'UTILITY',
 'Hola, soy el asistente de {{1}}. Vimos tu llamada y no pudimos contestar — te escribimos en cuanto podamos.',
 ARRAY['Peluquería Aurora'], 1),
('recall_caller_closed', 'es', 'UTILITY',
 'Hola, soy el asistente de {{1}}. Ahora mismo estamos cerrados, abrimos {{2}}. En cuanto abramos te contestamos.',
 ARRAY['Peluquería Aurora', 'mañana a las 9:00'], 2),
('recall_owner_message', 'es', 'UTILITY',
 'Recado de {{1}}: {{2}}',
 ARRAY['+34611223344', 'Quiere reservar cita para el sábado por la mañana'], 3),
('recall_daily_digest', 'es', 'UTILITY',
 'Hoy tuviste {{1}} llamadas perdidas: {{2}}. Responde con el número de la llamada para marcarla como gestionada.',
 ARRAY['3', '1) 611223344 – Quiere reservar cita · 2) número oculto – sin recado'], 4),
('recall_digest_clarify', 'es', 'UTILITY',
 'No entendí tu respuesta. ¿A cuál de estas llamadas te refieres? {{1}}',
 ARRAY['1) 611223344 – Quiere reservar cita · 2) 622334455 – Pregunta por horario'], 5),
('recall_monthly_report', 'es', 'UTILITY',
 'Tu resumen de {{1}}: {{2}} llamadas recuperadas, {{3}} contactadas, {{4}} reseñas nuevas (valoración media {{5}}).',
 ARRAY['agosto', '12', '10', '3', '4.8'], 6),
('recall_forwarding_instructions', 'es', 'UTILITY',
 E'Para activar el desvío de llamadas a tu línea de Kairikos, marca estos 3 códigos desde tu móvil (uno detrás de otro, pulsando llamar después de cada uno):\n\n1) **61*{{1}}#\n2) **67*{{1}}#\n3) **62*{{1}}#\n\nTu teléfono sigue funcionando igual que siempre — solo se desvían las llamadas que no coges, comunicas o no tienen cobertura.',
 ARRAY['+34910123456'], 7);
