-- =============================================================================
-- Kairikos — roles vestigiales de Supabase que una migración de Prisma
-- sigue necesitando.
--
-- Se ejecuta automáticamente por el propio mecanismo de la imagen oficial
-- de Postgres (todo lo que hay en /docker-entrypoint-initdb.d corre una
-- sola vez, y SOLO si el directorio de datos está genuinamente vacío —
-- ver el montaje de este directorio en docker-compose.yml, servicio
-- `postgres`). docker-compose.yml ya predecía este problema en su propio
-- comentario ("a legacy migration depends on Supabase-only roles this
-- plain Postgres image doesn't have") pero el script nunca se escribió
-- hasta que el primer `prisma migrate deploy` real, el 10 de septiembre
-- de 2026, lo destapó: la migración 20260613123901_lifecycle_triggers_
-- sql_functions hace `grant execute on function ... to authenticated,
-- service_role` sobre tres funciones (business_hours_elapsed,
-- operator_day_in_tz, wizard_abandoned_window) — y "migrate deploy" se
-- niega a seguir si el rol de destino de un GRANT no existe.
--
-- Por qué es seguro que estos roles existan sin más contenido: son un
-- resto de cuando este esquema se diseñó para Supabase, donde
-- `authenticated`/`service_role` son quien llama a través de PostgREST
-- bajo Row Level Security. Esta app no usa RLS ni PostgREST en ningún
-- sitio (comprobado: ningún ENABLE ROW LEVEL SECURITY ni CREATE POLICY
-- en las 85 migraciones) — el portal conecta siempre como el único rol
-- `kairikos`, vía Prisma. Así que estos dos roles no necesitan permisos
-- reales ni nadie inicia sesión como ellos jamás: solo tienen que existir
-- para que el GRANT no falle. NOLOGIN los deja inservibles como
-- credencial, que es la postura correcta para algo que no se usa.
--
-- Si esta migración cambia alguna vez para depender también de `anon` o
-- `authenticator` (los otros dos roles que trae Supabase de fábrica),
-- añádelos aquí con el mismo patrón — no en la migración misma.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    -- BYPASSRLS por fidelidad con lo que Supabase configura de fábrica,
    -- aunque hoy no haya ninguna política RLS que lo necesite — si
    -- alguna migración futura añade una, este rol ya está listo.
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END
$$;
