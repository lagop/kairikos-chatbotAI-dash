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
  scripts/
    apply-to-staging.sh                    # KAIA-743 data-plane runner
    run-staging-e2e.sh                     # KAIA-743 orchestrator (calls apply + Playwright)
    README.md                              # operator runbook
  tests/
    chatbot_clients_rls_smoke.sql          # local-dev (needs _local_auth_shim.sql)
    chatbot_clients_rls_smoke.staging.sql  # Supabase-port (no shim, used by apply-to-staging.sh)
    chatbot_clients_rls_smoke.run.log
    _local_auth_shim.sql                   # local-only, not for production
docs/
  chatbot-portal-schema.md
portal/
  tests/
    helpers/
      staging-magic-link.ts                # Supabase admin generateLink bridge
    specs/
      cross-tenant.staging.spec.ts         # @staging per-tenant magic-link e2e
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

## Staging apply (KAIA-740 + KAIA-743)

The end-to-end migration + seed + RLS smoke + per-tenant magic-link e2e
against the **staging** Supabase project is automated by two cooperating
scripts (pre-staged by [KAIA-743](/KAIA/issues/KAIA-743)):

- `supabase/scripts/apply-to-staging.sh` — the **data-plane** runner.
  `psql` + `pg_dump` + `curl`. Applies the schema, seeds the data, ensures
  the two `auth.users` rows exist via the Supabase Auth admin API, runs the
  8-check RLS smoke, captures a `pg_dump --schema-only` before/after diff,
  and fails loudly if anything other than the four `chatbot_*` tables
  changed. Idempotent. No `node` dependency.
- `supabase/scripts/run-staging-e2e.sh` — the **orchestrator**. Sits one
  level up. Calls `apply-to-staging.sh`, then runs the per-tenant
  Playwright magic-link spec at `portal/tests/specs/cross-tenant.staging.spec.ts`,
  then merges both logs into
  `supabase/tests/chatbot_clients_rls_smoke.staging.log` (the file the
  Backend Developer pastes into [KAIA-731](/KAIA/issues/KAIA-731) to close
  the chain). Has `--skip-apply` for re-running just the e2e against a
  known-good data plane.

Together they exist so the Backend Developer can run the whole chain —
**including the real magic-link e2e against the staging portal** — in a
single heartbeat the moment the operator drops the staging connection
strings into `.env`.

```bash
# 1. Operator drops the staging Supabase + portal values into .env
#    (gitignored). The full set of vars is documented in .env.example under
#    the "KAIA-740 staging-apply runbook" block. The 6 hard-required keys:
#      SUPABASE_URL
#      SUPABASE_ANON_KEY
#      SUPABASE_SERVICE_ROLE_KEY
#      SUPABASE_DB_URL
#      SUPABASE_SERVICE_ROLE_DB_URL
#      STAGING_PROJECT_REF            # hard guard against prod-by-mistake
#      PORTAL_URL                     # staging frontend URL, NOT localhost

# 2. (One-time, per staging project) Promote the staff test user in
#    Supabase Studio: Authentication -> Users -> staff-test@kairikos.dev
#    -> raw app_metadata = {"staff": true}. Required for the third e2e
#    case. The orchestrator fails fast with an actionable 403 if missing.

# 3. Backend Developer runs the full chain:
./supabase/scripts/run-staging-e2e.sh

# Or, if the data plane is already known-good, re-run only the e2e:
./supabase/scripts/run-staging-e2e.sh --skip-apply

# Or, for SQL-only pre-flight (no writes, no Playwright):
./supabase/scripts/apply-to-staging.sh --dry-run

# 4. To roll back, run the .down.sql migrations in reverse order:
psql "$SUPABASE_SERVICE_ROLE_DB_URL" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260609_1200_002_enable_rls_chatbot_portal.down.sql
psql "$SUPABASE_SERVICE_ROLE_DB_URL" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260609_1200_001_create_chatbot_portal_tables.down.sql
```

The data-plane runner:

- Verifies `psql` / `pg_dump` / `curl` / `jq` are on `PATH` and that `.env`
  is present and contains the required `SUPABASE_*` keys plus
  `STAGING_PROJECT_REF`.
- Parses the project ref out of `SUPABASE_URL` and refuses to run if it
  does not match `STAGING_PROJECT_REF` (defence against accidentally
  pointing at production).
- Pings the database over `SUPABASE_SERVICE_ROLE_DB_URL` to confirm the
  connection is live before any writes.
- Captures a `pg_dump --schema-only` baseline before any writes.
- Ensures the two deterministic `auth.users` rows (UUIDs `0a1` and `0a2`)
  exist — creates them via the Supabase Auth admin API if
  `SUPABASE_SERVICE_ROLE_KEY` is set, otherwise prints the exact Studio
  steps for the operator to follow.
- Applies the up migrations in order, then the seed, then the staging-port
  RLS smoke.
- Captures a second `pg_dump --schema-only` and diffs against the baseline,
  refusing to declare success if any addition outside the four `chatbot_*`
  tables, helpers, and RLS policies is detected.
- Emits a one-screen summary with the project ref, DB, file paths, smoke
  log path, per-tenant e2e results, and the rollback recipe.

The orchestrator wraps all of the above, then runs the Playwright e2e
spec against the staging portal. The e2e spec has three `@staging` cases:

1. Client A (Acme Clay Ovens) magic-link → `/portal` shows Acme, not Brisa.
2. Client B (Brisa Beach Houses) magic-link → `/portal` shows Brisa, not Acme.
3. Staff operator → `/admin/portal/clients` lists both.

The spec uses a real Supabase admin `auth.admin.generateLink` call (the
same path the production email would take) to skip the inbox click, then
follows the resulting `action_link` into the real `/api/auth/callback` and
asserts on the rendered portal. It auto-skips when `PORTAL_URL` is unset or
points at localhost, so it cannot accidentally run in dev.

The staging-port smoke (`supabase/tests/chatbot_clients_rls_smoke.staging.sql`)
is a Supabase-friendly rewrite of the local smoke. Key differences vs. the
local smoke:

- The local `_local_auth_shim.sql` is **not required** — Supabase provides
  `auth.uid()` / `auth.jwt()` natively.
- The smoke defines `auth.set_jwt(json)` locally (a `CREATE OR REPLACE`,
  scoped to the smoke) so it can plant a JWT into `request.jwt.claims`
  + per-claim GUCs from `psql` the way PostgREST would.
- Test user UUIDs, client UUIDs, and JWT strings are psql `-v` variables
  so the runner (or a debug session) can override them if the operator
  pre-created `auth.users` rows with different UUIDs than the runner
  script's deterministic defaults.
- The same 8 acceptance checks as the local smoke, plus three preflight
  checks: the `auth` schema + `auth.uid()` + `auth.jwt()` are present, the
  configured `auth.users` rows exist, and the `chatbot_client_users`
  mapping matches. The smoke fails fast with a clear remediation message
  if any of those preconditions is not met.

For the operator-facing runbook (one-time setup, the staff user promotion
step, rollback recipe, lens notes from the CTO review) see
[`supabase/scripts/README.md`](supabase/scripts/README.md).
