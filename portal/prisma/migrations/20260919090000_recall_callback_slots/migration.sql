-- Fase 3 — devolución de llamada agendada por quien llamó.
--
-- Aditiva y toda nullable: ninguna llamada existente cambia de
-- comportamiento. Una fila con callback_offered_slots a NULL es
-- exactamente «a esta persona no se le ofrecieron huecos», que es el
-- estado de todo el histórico.
--
-- CallEvent es un modelo nuevo y sí mapea a snake_case, al contrario que
-- ChatbotConversation — por eso aquí las columnas van en snake_case y el
-- índice puede escribirse sin comillas raras.

ALTER TABLE "CallEvent" ADD COLUMN "callback_offered_slots" JSONB;
ALTER TABLE "CallEvent" ADD COLUMN "callback_offered_at" TIMESTAMP(3);
ALTER TABLE "CallEvent" ADD COLUMN "callback_slot_at" TIMESTAMP(3);
ALTER TABLE "CallEvent" ADD COLUMN "callback_chosen_at" TIMESTAMP(3);

CREATE INDEX "CallEvent_subscription_id_callback_slot_at_idx"
    ON "CallEvent"("subscription_id", "callback_slot_at");
