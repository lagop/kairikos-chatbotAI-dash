-- Fase 1 — la entidad de contacto, con backfill del histórico.
--
-- El backfill es la parte que hay que leer con cuidado, porque decide qué
-- se puede hacer con los contactos que ya existían.
--
-- SE RECONSTRUYE EL CONTACTO, PERO NO SE LE INVENTA BASE LEGAL. Las
-- llamadas anteriores a la Fase 0 no llevaban aviso de oposición, así que
-- sus contactos nacen con `legal_basis` NULA — que es exactamente lo que
-- pasó. Solo se rellena para las llamadas que SÍ tienen
-- `legal_notice_sent_at`, y de esas se toma la PRIMERA: la base legal se
-- captura una vez, en el momento de recoger el dato, y una captura
-- posterior no mejora la de antes.
--
-- El efecto práctico es el que se quiere: el histórico entra en el
-- sistema y sirve para el asistente y para devolver llamadas, pero NO
-- para campañas. Un backfill que rellenara base legal a todo sería un
-- atajo que convierte una laguna legal en un dato que parece bueno.

CREATE TABLE IF NOT EXISTS "Contact" (
  -- Sin DEFAULT de servidor: el id lo pone Prisma, como el resto del
  -- esquema. Los INSERT de backfill de más abajo generan el suyo a mano.
  "id"                       UUID         NOT NULL,
  "client_id"                TEXT         NOT NULL,
  "tenant_id"                UUID,
  "e164"                     TEXT         NOT NULL,
  "name"                     TEXT,
  "email"                    TEXT,
  "source"                   TEXT         NOT NULL,
  "first_seen_at"            TIMESTAMP(3) NOT NULL,
  "last_interaction_at"      TIMESTAMP(3) NOT NULL,
  "legal_basis"              TEXT,
  "legal_basis_captured_at"  TIMESTAMP(3),
  "legal_basis_evidence_id"  UUID,
  "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"               TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Contact"
  ADD CONSTRAINT "Contact_client_id_fkey"
  FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Contact"
  ADD CONSTRAINT "Contact_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- La deduplicación entera depende de esto, y es POR CLIENTE: dos clientes
-- pueden tener al mismo cliente final y son dos contactos distintos, con
-- dos bases legales distintas.
CREATE UNIQUE INDEX IF NOT EXISTS "Contact_client_id_e164_key"
  ON "Contact" ("client_id", "e164");

CREATE INDEX IF NOT EXISTS "Contact_client_id_last_interaction_at_idx"
  ON "Contact" ("client_id", "last_interaction_at");

CREATE INDEX IF NOT EXISTS "Contact_tenant_id_idx"
  ON "Contact" ("tenant_id");

-- --------------------------------------------------------------------------
-- Las dos columnas que enganchan lo que ya existe
-- --------------------------------------------------------------------------

ALTER TABLE "CallEvent" ADD COLUMN IF NOT EXISTS "contact_id" UUID;
ALTER TABLE "Lead"      ADD COLUMN IF NOT EXISTS "contact_id" UUID;

-- SET NULL en ambos: borrar un contacto por retención NO puede borrar la
-- llamada ni el lead. El dato de negocio sobrevive al dato personal, que
-- es lo que permite seguir contando lo que pasó después de cumplir con un
-- borrado.
ALTER TABLE "CallEvent"
  ADD CONSTRAINT "CallEvent_contact_id_fkey"
  FOREIGN KEY ("contact_id") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Lead"
  ADD CONSTRAINT "Lead_contact_id_fkey"
  FOREIGN KEY ("contact_id") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "CallEvent_contact_id_idx" ON "CallEvent" ("contact_id");
CREATE INDEX IF NOT EXISTS "Lead_contact_id_idx"      ON "Lead" ("contact_id");

-- --------------------------------------------------------------------------
-- Backfill
-- --------------------------------------------------------------------------

-- 1. Un contacto por (cliente, número) de todo el histórico de llamadas.
--
--    Las llamadas con número oculto quedan fuera por el WHERE: no hay
--    número que deduplicar y esa llamada no es recuperable por definición.
--
--    array_agg()[1] en vez de min() para el tenant porque PostgreSQL no
--    trae agregados min/max para uuid. Da igual cuál se tome: todas las
--    llamadas de un mismo cliente comparten tenant.
INSERT INTO "Contact" (
  "id", "client_id", "tenant_id", "e164", "source",
  "first_seen_at", "last_interaction_at", "created_at", "updated_at"
)
SELECT
  gen_random_uuid(),
  ce."client_id",
  (array_agg(ce."tenant_id"))[1],
  ce."from_number",
  'inbound_call',
  MIN(ce."started_at"),
  MAX(ce."started_at"),
  NOW(),
  NOW()
FROM "CallEvent" ce
WHERE ce."from_number" IS NOT NULL
GROUP BY ce."client_id", ce."from_number"
ON CONFLICT ("client_id", "e164") DO NOTHING;

-- 2. Enganchar cada llamada a su contacto.
UPDATE "CallEvent" ce
SET "contact_id" = c."id"
FROM "Contact" c
WHERE c."client_id" = ce."client_id"
  AND c."e164" = ce."from_number"
  AND ce."from_number" IS NOT NULL
  AND ce."contact_id" IS NULL;

-- 3. Enganchar los leads cuyo teléfono case EXACTAMENTE.
--
--    Solo coincidencia exacta, a propósito. En un lead de recall el
--    teléfono viene de Twilio y ya es E.164; en uno de chatbot es lo que
--    el clasificador creyó entender de una conversación, y puede ser
--    cualquier cosa. Normalizar eso aquí, a ciegas y en SQL, sería
--    adivinar: los que no casen se quedan sin enganchar y el código nuevo
--    los irá resolviendo cuando vuelvan a aparecer.
UPDATE "Lead" l
SET "contact_id" = c."id"
FROM "Contact" c
WHERE c."client_id" = l."client_id"
  AND c."e164" = l."contact_phone"
  AND l."contact_phone" IS NOT NULL
  AND l."contact_id" IS NULL;

-- 4. Base legal SOLO donde el aviso salió de verdad, tomando la primera.
--
--    Hoy esto no toca prácticamente ninguna fila —la Fase 0 acaba de
--    entrar— y es correcto que así sea. Está escrito para que el día que
--    esta migración se aplique sobre una base con histórico posterior, la
--    evidencia suba al contacto en lugar de quedarse solo en la llamada.
UPDATE "Contact" c
SET "legal_basis"             = 'inbound_contact',
    "legal_basis_captured_at" = ev."notice_at",
    "legal_basis_evidence_id" = ev."call_id",
    "updated_at"              = NOW()
FROM (
  SELECT DISTINCT ON (ce."client_id", ce."from_number")
    ce."client_id",
    ce."from_number",
    ce."id"                   AS call_id,
    ce."legal_notice_sent_at" AS notice_at
  FROM "CallEvent" ce
  WHERE ce."legal_notice_sent_at" IS NOT NULL
    AND ce."from_number" IS NOT NULL
  ORDER BY ce."client_id", ce."from_number", ce."legal_notice_sent_at" ASC
) ev
WHERE c."client_id" = ev."client_id"
  AND c."e164" = ev."from_number"
  AND c."legal_basis" IS NULL;
