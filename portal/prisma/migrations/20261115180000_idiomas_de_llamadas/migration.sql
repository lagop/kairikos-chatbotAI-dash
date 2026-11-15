-- 15/11/2026 — Recuperación de llamadas en varios idiomas.
-- Ver src/lib/recall-caller-language.ts.

-- Idiomas activos por cliente. Por defecto solo español: los clientes de hoy
-- siguen exactamente igual y no se manda a Meta ninguna plantilla nueva.
ALTER TABLE "RecallSubscription"
  ADD COLUMN "caller_languages" TEXT[] NOT NULL DEFAULT ARRAY['es']::TEXT[];

-- El idioma en que salió el primer mensaje de cada llamada. Null en las
-- anteriores, que fueron en español.
ALTER TABLE "CallEvent"
  ADD COLUMN "caller_language" TEXT;
