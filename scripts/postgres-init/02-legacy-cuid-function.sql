-- =============================================================================
-- Kairikos — función cuid() vestigial que tres migraciones de Prisma
-- siguen pidiendo a nivel de base de datos.
--
-- Mismo mecanismo y mismo motivo que 01-legacy-supabase-roles.sql en esta
-- carpeta: corre una sola vez, solo sobre un directorio de datos
-- genuinamente vacío, vía docker-entrypoint-initdb.d.
--
-- Se descubrió el 10 de septiembre de 2026, en el primer `prisma migrate
-- deploy` real contra la VPS, justo después de resolver el hueco de los
-- roles de Supabase: la migración 20260624130000_password_reset_token
-- (y otras dos, add_user_table e intake_submission_table) declaran
-- `"id" TEXT NOT NULL PRIMARY KEY DEFAULT cuid()` — y Postgres no trae
-- `cuid()` de fábrica. CLAUDE.md ya documentaba este mismo mensaje de
-- error para la shadow database de `prisma migrate dev`
-- ("function cuid() does not exist") — es el mismo hueco, manifestado
-- también contra la base de datos real, no solo la de sombra, porque
-- nadie había hecho un `migrate deploy` desde cero hasta hoy.
--
-- Por qué es seguro que no reproduzca el algoritmo CUID de verdad: en
-- schema.prisma estos mismos campos son `@id @default(cuid())` — un
-- default de APLICACIÓN, no de base de datos. Prisma Client genera el
-- valor en JavaScript y lo manda siempre explícito en el INSERT, así que
-- el DEFAULT de la columna nunca se dispara en el camino real de la app;
-- es una red de seguridad para un INSERT manual que omita el id, no el
-- generador que usa el portal. Solo necesita devolver un texto único que
-- quepa en la clave primaria — no bytes idénticos a los que produciría
-- el paquete `cuid` de Node.
--
-- Si esto cambia alguna vez (una migración nueva que SÍ dependa del
-- formato exacto de cuid), sustitúyela aquí — no la reescribas dentro de
-- una migración ya aplicada; eso rompe el checksum que Prisma guarda en
-- _prisma_migrations para cualquier otro entorno que ya la tenga.
-- =============================================================================

CREATE OR REPLACE FUNCTION cuid() RETURNS text
LANGUAGE sql VOLATILE
AS $$
  SELECT 'c' || substr(
    md5(clock_timestamp()::text || random()::text || pg_backend_pid()::text),
    1, 24
  );
$$;
