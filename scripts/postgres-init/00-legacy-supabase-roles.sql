-- Found rehearsing a from-scratch local docker-compose bootstrap:
-- prisma/migrations/20260613123901_lifecycle_triggers_sql_functions
-- grants EXECUTE on three SQL helper functions to Postgres roles
-- `authenticated` and `service_role` — Supabase's
-- platform-managed roles, left over from when the portal ran on
-- Supabase Postgres, before the move to NextAuth.js + this VPS's own
-- plain `postgres:16-alpine` (docker-compose.yml's `postgres` service).
--
-- Neither role exists on a vanilla Postgres image, so `prisma migrate
-- deploy` fails outright (P3018, "role authenticated does not exist")
-- the moment it reaches that migration on any FRESH database — this
-- container's own compose stack cannot bootstrap from an empty volume
-- today. The grants themselves are vestigial: the app connects as
-- POSTGRES_USER (see docker-compose.yml), never as `authenticated` or
-- `service_role` — nothing in the current architecture uses Supabase's
-- RLS role split. This can't be fixed by editing that migration file:
-- it's already applied (and checksummed) on every database that
-- currently works, including this VPS's running Postgres, and editing
-- an applied migration would break `migrate deploy` there with a
-- checksum mismatch instead.
--
-- Postgres's official image runs every *.sql/*.sh file in
-- /docker-entrypoint-initdb.d, in filename order, exactly once — only
-- when the data directory is empty (a genuinely fresh volume). Mounted
-- here (see docker-compose.yml's `postgres` service `volumes:`) so any
-- future fresh bootstrap — a disaster-recovery rebuild, a new
-- environment, this same local rehearsal — has these roles in place
-- before migrations ever run. Idempotent and harmless everywhere else:
-- it never runs against a data directory that already has data, so the
-- VPS's current running Postgres is untouched by this file.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role;
  END IF;
END
$$;
