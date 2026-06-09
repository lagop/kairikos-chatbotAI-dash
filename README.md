# Kairikos — Chatbot AI portal backend

This repo is being bootstrapped incrementally. The first surface is the
**end-client portal** at `portal.kairikos.com`, scoped to
[KAIA-719](/KAIA/issues/KAIA-719) (plan rev 2).

## Repo layout (this snapshot)

```
supabase/
  migrations/
    20260609_1200_001_create_chatbot_portal_tables.sql
    20260609_1200_001_create_chatbot_portal_tables.down.sql
    20260609_1200_002_enable_rls_chatbot_portal.sql
    20260609_1200_002_enable_rls_chatbot_portal.down.sql
  seeds/
    chatbot_clients_seed.sql
  tests/
    chatbot_clients_rls_smoke.sql
    chatbot_clients_rls_smoke.run.log
    _local_auth_shim.sql           # local-only, not for production
docs/
  chatbot-portal-schema.md
```

Application code (NestJS, Stripe webhooks, /portal/* endpoints) lands under
`apps/api/` and `apps/web/` in follow-up issues ([KAIA-721](/KAIA/issues/KAIA-721),
[KAIA-733](/KAIA/issues/KAIA-733)). This snapshot only contains the database
schema and RLS policies per [KAIA-731](/KAIA/issues/KAIA-731).

## Quick start

```bash
# Apply migrations
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260609_1200_001_create_chatbot_portal_tables.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260609_1200_002_enable_rls_chatbot_portal.sql

# Seed (idempotent) — run as service_role
psql "$SUPABASE_SERVICE_ROLE_DB_URL" -v ON_ERROR_STOP=1 \
  -f supabase/seeds/chatbot_clients_seed.sql

# RLS smoke (acceptance test from KAIA-731)
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
  -f supabase/tests/chatbot_clients_rls_smoke.sql
```

Read [docs/chatbot-portal-schema.md](docs/chatbot-portal-schema.md) for the
full schema, RLS, and policy rationale.

## Environment variables

This PR is database-only. Variables used downstream by [KAIA-721](/KAIA/issues/KAIA-721)
are listed in `.env.example` for reference. **No real secrets are committed.**

## Local validation

The RLS smoke was validated against a local Postgres 18 instance. To
reproduce:

```bash
# 1. Create roles and shim auth.uid() / auth.jwt()
psql ... -f supabase/tests/_local_auth_shim.sql
# 2. Apply up migrations
psql ... -f supabase/migrations/20260609_1200_001_create_chatbot_portal_tables.sql
psql ... -f supabase/migrations/20260609_1200_002_enable_rls_chatbot_portal.sql
# 3. Seed (as superuser or service_role)
psql ... -f supabase/seeds/chatbot_clients_seed.sql
# 4. Run smoke (as a non-superuser with membership in `authenticated`)
psql ... -f supabase/tests/chatbot_clients_rls_smoke.sql
```

Latest passing run is in
`supabase/tests/chatbot_clients_rls_smoke.run.log`.
