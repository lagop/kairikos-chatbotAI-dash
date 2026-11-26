-- Huecos del encargo del tratamiento (26/11/2026), plan-portal-encargo-tratamiento.md.
--
-- 1. El aviso de privacidad que el servidor añade a la respuesta del bot en los
--    canales sin formulario (lib/contact-notice.ts). Aditiva y nullable: lo
--    anterior a hoy no tuvo aviso, y poner una fecha diría algo que no pasó.
--    ChatbotConversation es un modelo antiguo sin @@map: columna en snake_case.
-- 2. OutboundMessage.to_e164 pasa a admitir NULL: a los 12 meses del envío se
--    borra el número y se queda el coste (lib/processor-retention.ts).
-- 3. Índices para las dos caducidades, que corren con el cron retention-purge.

ALTER TABLE "ChatbotConversation" ADD COLUMN "contact_notice_shown_at" TIMESTAMP(3);

ALTER TABLE "OutboundMessage" ALTER COLUMN "to_e164" DROP NOT NULL;

CREATE INDEX "OutboundMessage_sent_at_idx" ON "OutboundMessage"("sent_at");

CREATE INDEX "ChannelWebhookDelivery_created_at_idx" ON "ChannelWebhookDelivery"("created_at");
