-- Reserva propia para villas — aviso de calendarios que fallan y reserva inmediata.
-- error_since: desde cuándo falla SEGUIDO la lectura de ese calendario (null si
-- la última fue bien). alerted_at: cuándo se avisó al dueño de esa racha; se
-- vacía al volver a leer bien, para avisar otra vez si vuelve a fallar.
ALTER TABLE "villa_calendar_feed" ADD COLUMN "error_since" TIMESTAMP(3);
ALTER TABLE "villa_calendar_feed" ADD COLUMN "alerted_at" TIMESTAMP(3);
-- Reserva inmediata: la solicitud se acepta sola al llegar si las fechas siguen
-- libres tras releer los iCal. Por defecto no (lib/villas/requests.ts).
ALTER TABLE "villa" ADD COLUMN "instant_booking" BOOLEAN NOT NULL DEFAULT false;
