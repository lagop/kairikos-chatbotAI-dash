-- A9/A10 — marcar una cuenta como interna.
--
-- ChatbotClient es un modelo ANTIGUO: sus columnas de siempre están en
-- camelCase ("createdAt"), pero las añadidas últimamente llevan @map a
-- snake_case (last_login_at, tos_accepted_at). Se sigue lo segundo.
--
-- DEFAULT false y NOT NULL: una cuenta es de cliente salvo que alguien diga
-- lo contrario. Si el defecto fuera al revés, un cliente real nuevo nacería
-- fuera de las métricas y nadie se enteraría.
ALTER TABLE "ChatbotClient" ADD COLUMN "is_internal" BOOLEAN NOT NULL DEFAULT false;

-- Se filtra por ella en cada carga del panel de métricas y en el barrido de
-- estadísticas de sector.
CREATE INDEX "ChatbotClient_is_internal_idx" ON "ChatbotClient"("is_internal");
