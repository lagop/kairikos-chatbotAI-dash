-- Same class of gap as 00-legacy-supabase-roles.sql, found in the same
-- rehearsal: 6 migrations (grep prisma/migrations for `cuid()`) declare
-- `DEFAULT cuid()` on an id column, relying on a `cuid()` SQL function
-- Supabase's Postgres ships and a plain postgres:16-alpine image does
-- not. On a fresh database `prisma migrate deploy` fails at the first
-- of them with "function cuid() does not exist".
--
-- This default is dead weight in normal operation, not a real
-- dependency: every one of those columns is `@default(cuid())` in
-- schema.prisma, and Prisma Client generates that value in JavaScript
-- itself before every insert — it never relies on or invokes a
-- database-level default for a cuid field. The DB-level default only
-- matters for a row inserted via raw SQL that omits the id, which
-- nothing in this codebase does. So this doesn't need to be a
-- byte-perfect cuid implementation (counter + fingerprint + timestamp,
-- base36-encoded) — it only needs to exist, return a plausible-looking
-- text id, and never collide, so the six CREATE TABLE statements that
-- reference it succeed on a fresh bootstrap.
CREATE OR REPLACE FUNCTION public.cuid()
RETURNS text
LANGUAGE sql
VOLATILE
AS $$
  SELECT 'c' || substr(md5(random()::text || clock_timestamp()::text || random()::text), 1, 24);
$$;
