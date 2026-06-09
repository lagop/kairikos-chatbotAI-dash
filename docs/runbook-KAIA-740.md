# Runbook — KAIA-740: apply KAIA-731 to Supabase staging + RLS smoke

> **Audience:** the operator who drops credentials, and the engineer who
> wakes up when the operator does. This file is meant to be read top-to-bottom
> once and then followed step by step.

**Issue:** [KAIA-740](/KAIA/issues/KAIA-740) (parent)
**Pre-stage work:** [KAIA-743](/KAIA/issues/KAIA-743) (this file is part of that deliverable)
**Schema + RLS:** [KAIA-731](/KAIA/issues/KAIA-731)
**Goal:** unblock the chatbot portal MVP path on
[Chatbots AI dashboard](/KAIA/projects/bbe7754b-a8a8-4e1d-86b6-8cbbc4cfa3a4) →
€3k–€5k/month recurring revenue in 1–3 months.

---

## TL;DR

1. **Operator:** copy `.env.example` → `.env` and fill in the five
   `SUPABASE_*` values for the **staging** project. Add
   `STAGING_PROJECT_REF=<the-project-ref>`.
2. **Operator:** create two test users in Supabase Studio → Authentication
   → Users (or let the script do it via the Admin API). See "Test users"
   below for the deterministic UUIDs and emails.
3. **Engineer (or operator):** run the runner:

   ```bash
   ./supabase/scripts/apply-to-staging.sh --dry-run   # confirm sanity
   ./supabase/scripts/apply-to-staging.sh              # actually apply
   ```

4. **Inspect:** the runner prints a one-screen summary. The post-diff
   must be additive-only and limited to the four `chatbot_*` tables. The
   RLS smoke must report **8/8 checks passed**.

---

## What the runner does (in order)

| # | Step                              | Why                                                                 |
|---|-----------------------------------|---------------------------------------------------------------------|
| 0 | Sanity (tools, `.env`, refs, ping) | Refuse to run unless staging is reachable and creds are correct.    |
| 1 | `pg_dump --schema-only` (pre)     | Baseline for the post-diff.                                         |
| 2 | Apply migrations 001 + 002        | Idempotent (`if not exists` / `drop policy if exists`).             |
| 3 | Apply seed                        | Idempotent (`on conflict do nothing`).                              |
| 4 | Ensure two test `auth.users` rows | Via Admin API if `SUPABASE_SERVICE_ROLE_KEY` is set, else via Studio.|
| 5 | Run RLS smoke                     | 8/8 checks. Writes `supabase/tests/chatbot_clients_rls_smoke.staging.log`. |
| 6 | `pg_dump --schema-only` (post)    | Diff against pre. Fails if anything other than `chatbot_*` changed. |
| 7 | Print one-screen summary          | Success line, smoke result, rollback hint.                          |

> **If anything in the post-diff is unexpected, abort — do not apply to staging twice.**

---

## Operator: drop staging credentials

Edit the project's `.env` file (NOT `.env.example`):

```bash
# Supabase (staging project)
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_ANON_KEY=eyJ...                 # Project Settings -> API -> anon public
SUPABASE_SERVICE_ROLE_KEY=eyJ...         # Project Settings -> API -> service_role
SUPABASE_DB_URL=postgres://postgres:<db-password>@db.<ref>.supabase.co:5432/postgres
SUPABASE_SERVICE_ROLE_DB_URL=postgres://postgres.<ref>:<db-password>@aws-0-<region>.pooler.supabase.com:6543/postgres
# ^^^ the "Transaction" pooler URL with the service_role-bypassing user.
# For the migration runner, EITHER URL works because we set local role explicitly.
# Pooler URL is recommended (Supabase project connections are rate-limited).

# Project ref — must match SUPABASE_URL host
STAGING_PROJECT_REF=<ref>
```

The runner will:

* Refuse to run if any of those 5 vars is empty.
* Refuse to run if `STAGING_PROJECT_REF` is missing.
* Refuse to run if `STAGING_PROJECT_REF` does not match the host segment
  of `SUPABASE_URL` (this is the "wrong project" guard).
* Try a DB ping with the service-role URL before doing anything.

### Test users

The seed expects two `auth.users` rows with deterministic UUIDs so the
`chatbot_client_users` mapping rows can match:

| Role in test  | UUID                                   | Email                              |
|---------------|----------------------------------------|------------------------------------|
| Client A owner | `00000000-0000-0000-0000-0000000000a1` | `onboarding-test1@kairikos.dev`    |
| Client B owner | `00000000-0000-0000-0000-0000000000a2` | `onboarding-test2@kairikos.dev`    |

**Option A — let the runner do it (preferred):** make sure
`SUPABASE_SERVICE_ROLE_KEY` is set. The runner will POST to
`$SUPABASE_URL/auth/v1/admin/users` with the desired UUID + email +
`email_confirm: true` + `aud: authenticated`.

**Option B — operator creates them in Studio:**

1. Supabase Studio → Authentication → Users → **Add user** → **Create new user**.
2. Paste the UUID from the table above (you can paste into the
   "User UID" advanced field; otherwise copy the auto-generated UUID
   and pass it as `-v user_a=...` to override the smoke).
3. Tick **Auto Confirm User**.
4. Password can be anything; the smoke never logs in with it.

If you create the users with **different** UUIDs than the table, pass
them to the runner explicitly:

```bash
./supabase/scripts/apply-to-staging.sh \
  -v user_a=<real-uuid-a> \
  -v user_b=<real-uuid-b> \
  ...
```

(The runner forwards `-v` to `psql` for the smoke step; the script
itself uses the deterministic IDs for the Admin API create, so use
Option A unless you really can't.)

---

## Engineer: run it

```bash
# 1. Sanity (no DB writes, no migrations)
./supabase/scripts/apply-to-staging.sh --dry-run

# Expected last line: "DRY RUN: all sanity checks passed."

# 2. Real run
./supabase/scripts/apply-to-staging.sh

# Expected last line: "=== KAIA-740 staging apply + smoke: SUCCESS ==="
# The summary will print per-tenant e2e results.
```

The runner captures:

* `supabase/tests/chatbot_clients_rls_smoke.staging.log` — full smoke output
* `/tmp/kaia-740-pre.schema.sql` and `/tmp/kaia-740-post.schema.sql` — for the diff
* `/tmp/kaia-740-schema.diff` — the unified diff (additive-only check)
* `/tmp/kaia-740-{001,002,seed}.log` — per-step psql output (only on failure)

### Exit codes

| Code | Meaning                                                              |
|------|----------------------------------------------------------------------|
| 0    | Success. Smoke passed. Diff is clean.                                |
| 1    | Any pre-flight failure (env, refs, ping) or DB error during apply.   |
| 64   | Bad CLI arg (e.g. `--typo`).                                         |

---

## Rollback

If you need to back out **after** the runner has already applied:

```bash
# 1. Roll back the RLS policies (down 002)
psql "$SUPABASE_SERVICE_ROLE_DB_URL" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260609_1200_002_enable_rls_chatbot_portal.down.sql

# 2. Drop the four tables (down 001)
psql "$SUPABASE_SERVICE_ROLE_DB_URL" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260609_1200_001_create_chatbot_portal_tables.down.sql

# 3. Optional: remove the test auth.users rows (Studio -> Users -> Delete)
```

The down migrations are intentionally simple: they DROP POLICY, REVOKE,
and DROP TABLE. They will refuse to run if any non-chatbot object
references the four tables.

---

## Idempotency — re-runs are safe

| Component | Idempotency mechanism                                                 |
|-----------|-----------------------------------------------------------------------|
| 001 tables | `create table if not exists`, `create index if not exists`, `create or replace function` |
| 002 RLS    | `drop policy if exists` then `create policy`, `enable` / `force` row level security |
| Seed       | `on conflict (id) do nothing`, `on conflict (user_id) do nothing`, `on conflict (client_id, external_id) do nothing` |
| Auth users | `auth.set_jwt` is a CREATE OR REPLACE. The Admin API would 400 on duplicate email — we probe by id first. |
| Smoke      | The failure counter resets each run. The 0a/0b sanity probes catch the "operator pre-created users in Studio with different UUIDs" failure mode early. |

---

## Failure modes (and what the runner does)

| Symptom                                                          | What the runner does                                                                                              |
|------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------|
| `.env` missing or `SUPABASE_*` empty                             | Refuses to run. Lists which vars are missing.                                                                    |
| `STAGING_PROJECT_REF` missing or mismatches `SUPABASE_URL` host  | Refuses to run. Prints both refs side by side.                                                                   |
| DB ping fails                                                    | Refuses to run. Prints the psql error.                                                                            |
| Migration fails                                                  | Hard-stops. Tail of the failing step's log is printed. **`psql -v ON_ERROR_STOP=1` means a partial transaction.** |
| Seed fails                                                       | Hard-stops. Same as above.                                                                                       |
| `auth.users` row missing and `SUPABASE_SERVICE_ROLE_KEY` unset   | Prints the exact `createUser` payload for the operator to run in Studio, then dies.                              |
| Admin API create fails                                           | Prints HTTP code + response body. Dies.                                                                           |
| Smoke fails                                                      | Hard-stops. Tail of the smoke log is printed. Full log in `supabase/tests/chatbot_clients_rls_smoke.staging.log`. |
| Post-diff contains non-`chatbot_*` additions                     | **Hard-stops with a screaming warning.** This is the "we accidentally changed something else" guard. Diff is preserved at `/tmp/kaia-740-schema.diff` for forensics. **Do not re-apply blindly.** |

---

## Related issues

* [KAIA-731](/KAIA/issues/KAIA-731) — schema + RLS (done; this is what we apply)
* [KAIA-739](/KAIA/issues/KAIA-739) — portal lint check (must be green for migrations to land)
* [KAIA-742](/KAIA/issues/KAIA-742) — portal mirror resync (done; canonical hash in 001 is up to date)
* [KAIA-743](/KAIA/issues/KAIA-743) — this pre-staged runner
* [KAIA-740](/KAIA/issues/KAIA-740) — the actual unblock (this is the parent)
