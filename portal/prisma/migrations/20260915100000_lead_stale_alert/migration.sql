-- Fase 2.4 — marcador de "ya avisamos al cliente de que este lead está
-- frío", para no repetir el aviso en cada tick del cron. Se limpia al
-- cambiar de estado (ver la ruta PATCH /api/portal/leads/[id]): un lead que
-- vuelve a atascarse en el estado siguiente sí es una noticia nueva.

ALTER TABLE "Lead" ADD COLUMN "stale_alert_sent_at" TIMESTAMP(3);

-- El barrido busca por estado abierto y sin avisar.
CREATE INDEX "Lead_status_stale_alert_sent_at_idx" ON "Lead"("status", "stale_alert_sent_at");
