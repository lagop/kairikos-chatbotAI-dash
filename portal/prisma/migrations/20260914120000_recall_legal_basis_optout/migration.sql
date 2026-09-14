-- Fase 0 — aviso de oposición y baja del llamante.
--
-- Aditiva y sin backfill, a propósito: las llamadas anteriores a esta
-- migración NO recibieron el aviso, y rellenarles una versión sería
-- fabricar la evidencia que estas columnas existen para guardar. Se
-- quedan en NULL, que es exactamente lo que pasó.
--
-- Nombres: las tablas de este esquema no llevan @@map, así que van
-- entrecomilladas en PascalCase; las columnas de estos dos modelos sí
-- usan @map a snake_case (ver la advertencia de CLAUDE.md — los modelos
-- antiguos como ChatbotConversation no lo hacen).

ALTER TABLE "CallEvent"
  ADD COLUMN IF NOT EXISTS "legal_notice_version" TEXT,
  ADD COLUMN IF NOT EXISTS "legal_notice_sent_at" TIMESTAMP(3);

ALTER TABLE "RecallBlockedNumber"
  ADD COLUMN IF NOT EXISTS "opt_out_at" TIMESTAMP(3);

-- Sin índice nuevo a propósito: el @@unique([subscriptionId, e164]) que ya
-- existe indexa por subscriptionId como prefijo, que es como se consulta
-- esta tabla ("las bajas de esta suscripción"). Y son unas pocas filas por
-- cliente — un índice más aquí solo añadiría escritura.
