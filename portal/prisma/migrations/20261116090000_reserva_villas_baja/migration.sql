-- Reserva propia para villas — baja del cliente (docs/plan-reserva-villas.md).
-- Cuándo se avisó al dueño de la baja: el cron no purga sin aviso previo y el
-- plazo de gracia nunca acaba antes de 7 días desde él (lib/villas/exit-rules.ts).
ALTER TABLE "villa_rental" ADD COLUMN "exit_notified_at" TIMESTAMP(3);
