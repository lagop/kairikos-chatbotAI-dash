-- A11 / A1 · Enlaces públicos del borrador y del informe.
--
-- El prospecto no tiene sesión de operador: la única forma de que vea lo que
-- le mandas por WhatsApp es una URL que valga por sí sola.
--
-- Las dos columnas nacen NULL, se rellenan con un token por fila y solo
-- entonces pasan a NOT NULL + UNIQUE. Hacerlo en un paso fallaría en cuanto
-- haya una fila (y ya hay borradores e informes generados en producción).
-- gen_random_uuid() viene de pgcrypto, ya disponible en este Postgres: sirve
-- para el relleno de una vez, mientras que las filas nuevas traen su token
-- desde la aplicación (32 bytes aleatorios).

ALTER TABLE "ProspectingWebDraft" ADD COLUMN IF NOT EXISTS "share_token" TEXT;
ALTER TABLE "ProspectingCompetitorSnapshot" ADD COLUMN IF NOT EXISTS "share_token" TEXT;

UPDATE "ProspectingWebDraft"
   SET "share_token" = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
 WHERE "share_token" IS NULL;

UPDATE "ProspectingCompetitorSnapshot"
   SET "share_token" = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
 WHERE "share_token" IS NULL;

ALTER TABLE "ProspectingWebDraft" ALTER COLUMN "share_token" SET NOT NULL;
ALTER TABLE "ProspectingCompetitorSnapshot" ALTER COLUMN "share_token" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "ProspectingWebDraft_share_token_key"
    ON "ProspectingWebDraft"("share_token");

CREATE UNIQUE INDEX IF NOT EXISTS "ProspectingCompetitorSnapshot_share_token_key"
    ON "ProspectingCompetitorSnapshot"("share_token");
