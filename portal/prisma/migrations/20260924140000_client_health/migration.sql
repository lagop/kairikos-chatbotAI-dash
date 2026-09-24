-- A8 y A4 · Dos columnas en el cliente.
--
-- last_login_at: hasta ahora solo el Operator tenía última entrada, así que
-- "lleva un mes sin asomarse" —una de las tres señales de que alguien se va a
-- ir— no se podía ni preguntar. Lo sella el login del portal.
--
-- last_value_report_at: el cursor del informe de valor semanal. La cadencia
-- la decide TypeScript con esta columna y no el scheduler, igual que el resto
-- de barridos del repo.
--
-- Ojo con los nombres: "ChatbotClient" es un modelo ANTIGUO y casi todas sus
-- columnas van en camelCase sin @map. Estas dos sí lo llevan, así que aquí
-- van en snake_case. Comprobado contra el modelo antes de escribir el DDL.

ALTER TABLE "ChatbotClient" ADD COLUMN IF NOT EXISTS "last_login_at" TIMESTAMP(3);
ALTER TABLE "ChatbotClient" ADD COLUMN IF NOT EXISTS "last_value_report_at" TIMESTAMP(3);

-- A3 · El contador de la secuencia de bienvenida, por unidad contratada.
-- Va en ClientProduct y no en una tabla nueva porque es un contador por
-- contrato y no tiene vida propia.
ALTER TABLE "ClientProduct" ADD COLUMN IF NOT EXISTS "onboarding_drip_step" INTEGER NOT NULL DEFAULT 0;
