-- Widget v2 (25/11/2026) — consentimiento del formulario de contacto del chat
-- web: cuándo marcó la casilla el visitante y qué versión del aviso leyó
-- (lib/web-widget-context.ts, WIDGET_CONTACT_NOTICES). Plan del encargo del
-- tratamiento, PR 3.
--
-- Aditiva y nullable: no hay backfill. Lo anterior a hoy no tuvo casilla, y
-- poner una fecha ahí diría algo que no pasó. OJO: ChatbotConversation es un
-- modelo ANTIGUO, sin @@map y con columnas viejas en camelCase ("clientId");
-- las nuevas van en snake_case con @map, como "handoff_requested_at".

ALTER TABLE "ChatbotConversation" ADD COLUMN "contact_consent_at" TIMESTAMP(3);
ALTER TABLE "ChatbotConversation" ADD COLUMN "contact_notice_version" TEXT;
