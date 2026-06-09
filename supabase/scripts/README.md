# supabase/scripts — staging apply runbook

This directory contains the two scripts the Backend Developer runs against
the Kairikos Supabase **staging** project to satisfy the [KAIA-740
acceptance criteria](../README.md). Together they implement the gate that
closes the [KAIA-731](../tests/chatbot_clients_rls_smoke.staging.sql) chain.

## TL;DR

```bash
# 0. One-time: operator fills .env (see "Operator setup" below).
cp .env.example .env
$EDITOR .env   # paste the 6 staging values

# 1. Run the whole thing — apply, seed, RLS smoke, e2e magic-link check.
./supabase/scripts/run-staging-e2e.sh

# 2. Paste the merged log into a comment on KAIA-731 and mark it done.
#    Then mark KAIA-740 done. KAIA-732 / 736 / 738 auto-unblock.
```

## The two scripts

| Script | Purpose | When to run |
|---|---|---|
| `apply-to-staging.sh` | Apply 001 + 002 migrations, seed, ensure the two test `auth.users` rows, run the SQL RLS smoke, capture pre/post `pg_dump` and fail on any non-additive change. | Owned by the Backend Developer (KAIA-740). Idempotent. |
| `run-staging-e2e.sh` | Orchestrator. Calls `apply-to-staging.sh` then runs the per-tenant Playwright magic-link spec against the staging portal. Writes a merged log. | One-shot per staging release. |

Run `run-staging-e2e.sh` for the full path. If you only need to re-run the
e2e (the apply already happened), use `./supabase/scripts/run-staging-e2e.sh
--skip-apply`.

## Operator setup (one-time per staging project)

`run-staging-e2e.sh` refuses to run if `.env` is missing or the staging
identity cannot be verified. The operator must populate the project-root
`.env` with these six values **from the staging project, never from
production**:

```bash
# Supabase staging
SUPABASE_URL=https://<STAGING-REF>.supabase.co
SUPABASE_ANON_KEY=<anon>
SUPABASE_SERVICE_ROLE_KEY=<service-role>
SUPABASE_DB_URL=postgres://postgres:<pw>@db.<STAGING-REF>.supabase.co:5432/postgres
SUPABASE_SERVICE_ROLE_DB_URL=postgres://postgres:<pw>@db.<STAGING-REF>.supabase.co:5432/postgres
# Staging frontend (Next.js dev portal pointing at the staging Supabase)
PORTAL_URL=https://staging--portal.kairikos.com
# Hard safety check — must match the host part of SUPABASE_URL
STAGING_PROJECT_REF=<STAGING-REF>
```

The `.env` file is in `.gitignore`. Do not paste keys into the issue
thread, the repo, or any Paperclip-searchable surface.

### Pre-apply Supabase Auth prep (one-time per staging project)

The SQL seed does not (and must not) create `auth.users` rows. Either:

1. **Allow the script to do it.** `apply-to-staging.sh` calls the
   Supabase Auth admin `/auth/v1/admin/users` endpoint with
   `SUPABASE_SERVICE_ROLE_KEY` and plants two deterministic users:
   - `onboarding-test1@kairikos.dev` → `00000000-0000-0000-0000-0000000000a1` (Acme Clay Ovens)
   - `onboarding-test2@kairikos.dev` → `00000000-0000-0000-0000-0000000000a2` (Brisa Beach Houses)

2. **Or, create them by hand** in Supabase Studio and pass the resulting
   UUIDs to the smoke via `psql -v user_a=<id> -v user_b=<id> -v
   user_c=<id> -v user_staff=<id> -v client_a=... -v client_b=...`. The
   runner already supports that — see the comment in
   `apply-to-staging.sh` step 5.

### Staff user for the e2e (one-time per staging project)

The third e2e test in `cross-tenant.staging.spec.ts` logs in as a staff
operator. Staff-ness is **not** in the seed (the seed has no concept of
operators) — set it by hand in Supabase Studio:

- **Authentication → Users → `staff-test@kairikos.dev` → raw app_metadata**:

  ```json
  { "staff": true }
  ```

Or pre-create the user with that metadata via the admin API. If the flag
is missing, the test fails with an actionable 403 message that points
exactly at this step.

## What the orchestrator produces

On success, the run writes:

- `supabase/tests/chatbot_clients_rls_smoke.staging.log` — the merged log
  (SQL RLS smoke + Playwright e2e + JUnit pointer). **This is the file
  the Backend Developer pastes into KAIA-731.**
- `supabase/tests/artifacts/staging-e2e.<UTC-timestamp>.log` — raw
  Playwright stdout/stderr.
- `/tmp/kaia-740-staging-e2e.junit.xml` — JUnit XML for the e2e run.
- `/tmp/kaia-740-pre.schema.sql` and `/tmp/kaia-740-post.schema.sql` —
  the diff inputs. The post-diff step in `apply-to-staging.sh` hard-fails
  if anything other than the four `chatbot_*` tables differs.

## Idempotency

- Migrations use `if not exists` / `drop policy if exists`.
- Seed uses `on conflict ... do nothing` keyed on stable identifiers.
- The smoke is re-runnable.
- Auth users are planted with deterministic UUIDs; the runner prints
  "auth users already present" on re-run.

You can safely re-run `run-staging-e2e.sh` after a fix.

## Rollback (if you must)

```bash
psql "$SUPABASE_SERVICE_ROLE_DB_URL" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260609_1200_002_enable_rls_chatbot_portal.down.sql
psql "$SUPABASE_SERVICE_ROLE_DB_URL" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260609_1200_001_create_chatbot_portal_tables.down.sql
```

The post-diff step is the first line of defence — it refuses to call
the apply "clean" if anything other than the four `chatbot_*` tables
changed. If the diff surprises you, **do not** re-apply; investigate
the staging project state first.

## Lens notes (CTO review)

- **Blast radius:** every apply goes through a hard post-diff. The script
  refuses to advance if a non-`chatbot_*` table changed, so a buggy
  migration can never quietly touch unrelated schemas.
- **Reversibility:** every migration has a `.down.sql` companion checked
  into `supabase/migrations/`. The README documents the rollback sequence
  in the same place as the apply sequence.
- **Separation of concerns:** the SQL RLS smoke is in `supabase/tests/`
  (data-plane), the e2e is in `portal/tests/specs/` (presentation-plane),
  and the orchestrator is in `supabase/scripts/` (runbook-plane). Each
  file has one job.
- **Automation ceiling:** `run-staging-e2e.sh` removes the most
  expensive manual step (the magic-link email click) by using the
  Supabase admin `generateLink` API, which is the same path the email
  would have taken.
- **MTTD/MTTR over MTBF:** the post-diff and the JUnit XML surface
  failures within seconds; the merged log preserves the full transcript
  for postmortem.
- **Incremental delivery:** the script is split into `--skip-apply` and
  the full path so a re-run of only the e2e is cheap once the data
  plane is known good.
- **Dependency cost:** no new runtime dependencies. The e2e uses the
  `@supabase/supabase-js` and `@playwright/test` already in
  `portal/package.json`. No new packages added.
- **Technical debt interest rate:** none deferred. The deterministic
  UUIDs in the seed + the admin `generateLink` flow would normally be
  called "test debt" — the README documents the operator hand-step
  (Studio user creation) so we know who owns the debt.
