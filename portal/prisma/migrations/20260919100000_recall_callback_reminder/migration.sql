-- Fase 3 — recordatorio al dueño antes de la devolución de llamada.
--
-- Aditiva y nullable. NULL en todo el histórico significa «pendiente de
-- avisar», que es correcto: ninguna llamada anterior tiene hueco elegido,
-- así que el barrido no las mirará nunca (filtra por callback_slot_at).

ALTER TABLE "CallEvent" ADD COLUMN "callback_reminded_at" TIMESTAMP(3);
