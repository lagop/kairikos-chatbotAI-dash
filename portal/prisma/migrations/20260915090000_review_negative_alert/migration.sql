-- Fase 2.2 — marcador de "ya avisamos de esta reseña negativa", para que
-- el aviso sea exactamente-una-vez. Ver lib/review-alerts.ts: al activar
-- la función, las reseñas negativas antiguas se sellan sin enviar nada,
-- de modo que nadie recibe una avalancha por su histórico.

ALTER TABLE "GoogleReview" ADD COLUMN "negative_alert_sent_at" TIMESTAMP(3);

-- El barrido busca exactamente por esto: negativas sin avisar.
CREATE INDEX "GoogleReview_client_id_star_rating_negative_alert_sent_at_idx"
  ON "GoogleReview"("client_id", "star_rating", "negative_alert_sent_at");
