# KAIA-1585 — Seed a portal Prisma `Operator` row for the staging login smoke

**Audience:** the operator who can reach the Supabase dashboard and the QA Engineer driving the [KAIA-1254](/KAIA/issues/KAIA-1254) operator login smoke.
**Owner:** Backend Developer ([8e6c4068-255f-45b4-b233-e5c97d58d040](https://www.paperclip.local/KAIA/agents/backend-developer))
**Last updated:** 2026-06-16
**Status:** ready to run
**Blast radius:** staging DB only (`ikexqreuvoqwvwopftkt`). Inserts / updates exactly one row in the public.`Operator` table. No schema changes.

---

## TL;DR

1. Pull the staging Supabase service-role key and the staging operator password from 1Password (see [§ 1Password references](#1password-references)).
2. Run the seed script (see [§ Run the seed](#run-the-seed)) — about 5 seconds, exits 0.
3. Verify the row from the Supabase SQL editor (see [§ Verify](#verify)).
4. Hand the seeded credentials to the QA Engineer so they can drive [KAIA-1254](/KAIA/issues/KAIA-1254).

Total time: 2 minutes.

---

## Why this exists

The 16 portal Prisma PascalCase tables were reconciled into the staging Supabase DB on [KAIA-1570](/KAIA/issues/KAIA-1570) (additive, idempotent — no Botpress-side tables touched). The `Operator` table is now present but **empty** (0 rows), which means the QA smoke on [KAIA-1254](/KAIA/issues/KAIA-1254) cannot drive a real `POST /api/operator/login` to confirm the original 500 is gone.

This runbook seeds exactly one `Operator` row so the smoke can pass.

---

## 1Password references

- `op://Kairikos/Staging/Supabase Service Role Key` — paste into `SUPABASE_SERVICE_ROLE_KEY` at run time.
- `op://Kairikos/Staging/Operator Password (staging)` — paste into `OPS_STAGING_OPERATOR_PASSWORD` at run time. **Never** commit this value.

If the staging operator password is not in 1Password yet, generate one (suggested: `openssl rand -base64 24`) and store it under `Kairikos / Staging / Operator Password (staging)`. The seed is idempotent, so rotating the password is a re-run of the script.

---

## Run the seed

From the portal repo root (the same path the staging deploy uses):

```bash
cd /paperclip/instances/default/projects/fe217b5c-badf-4f17-ab20-f089478a35c7/bbe7754b-a8a8-4e1d-86b6-8cbbc4cfa3a4/_default/portal

# Pull from 1Password (paste values, do not echo):
export SUPABASE_URL="https://ikexqreuvoqwvwopftkt.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="<paste from 1Password>"
export OPS_STAGING_OPERATOR_EMAIL="ops-staging@kairikos.com"   # default; override only if you must
export OPS_STAGING_OPERATOR_PASSWORD="<paste from 1Password>"

npx tsx scripts/seed-staging-operator.ts
```

### Expected output (first run — insert)

```text
[seed-staging-operator] OK (inserted new row)
  id          : <uuid>
  email       : ops-staging@kairikos.com
  isActive    : true
  createdAt   : 2026-06-16T...
  updatedAt   : 2026-06-16T...
  passwordHash: <redacted>
```

### Expected output (subsequent run — update)

```text
[seed-staging-operator] OK (updated existing row)
  id          : <same uuid>
  email       : ops-staging@kairikos.com
  isActive    : true
  updatedAt   : 2026-06-16T...
  passwordHash: <redacted>
```

A re-run is fully idempotent: it refreshes `passwordHash`, `isActive`, and `updatedAt` on the existing row and never inserts a duplicate.

### Why a `tsx` script and not `prisma db execute` / direct Postgres

The agent runtime cannot reach `db.ikexqreuvoqwvwopftkt.supabase.co:5432` (`Network is unreachable` — see KAIA-1435, KAIA-1472). The Supabase REST API is reachable on 443 from anywhere, and the service-role key bypasses RLS, so a `@supabase/supabase-js` insert is the right tool here. The schema is small (one row, ten columns) so we hand-roll it instead of standing up a Prisma migration just for a seed.

---

## Verify

After the script reports `OK`, run each of these in the Supabase SQL editor (open a new query for each so you can read the output). They confirm the row matches the schema in `portal/prisma/schema.prisma`.

### V.1 — The row exists with the expected email and is active

```sql
select id, email, isActive, totpEnrolledAt, lastLoginAt
from "Operator"
where email = 'ops-staging@kairikos.com';
```

**Expected:** exactly one row. `isActive` is `true`. `totpEnrolledAt` and `lastLoginAt` are `NULL` (TOTP is out of scope for the v1 smoke — see issue body).

### V.2 — The row count matches the `select count(*)` from the issue acceptance criteria

```sql
select count(*) as operator_rows from "Operator";
```

**Expected:** `1`. If higher, another seeded row was added in parallel — investigate before running the smoke.

### V.3 — The password hash is argon2id (so the request path can `verifyPassword` it)

The hash starts with `$argon2id$`. You can read the prefix without copying the full hash:

```sql
select substring("passwordHash" for 10) as hash_prefix
from "Operator"
where email = 'ops-staging@kairikos.com';
```

**Expected:** `$argon2id$`. If the prefix is anything else, the seed script did not use `src/lib/operator-crypto.ts:hashPassword` and the request path will reject the password on the smoke.

### V.4 — Smoke-test the login end-to-end

Once V.1–V.3 pass, hand the seeded credentials to the QA Engineer. They can confirm the original 500 is gone with:

```bash
curl -sS -X POST https://project-fxidg.vercel.app/api/operator/login \
  -H "Content-Type: application/json" \
  -d '{"email":"ops-staging@kairikos.com","password":"<paste from 1Password>"}'
```

**Expected (after the seed):** HTTP 200 with `{"totpRequired":false}`. The 500 from [KAIA-1254](/KAIA/issues/KAIA-1254) is replaced by a clean 200.

---

## What the seed does NOT do

- **No RLS on the `Operator` table.** The portal uses the Supabase `service_role` key server-side, which bypasses RLS. The magic-link signin flow on the client uses the anon key and never reads `Operator`. RLS is intentionally out of scope for this child (see the issue body's "Out of scope" section).
- **No TOTP enrollment.** `totpSecret` is `NULL`. The smoke does not exercise TOTP. If a future smoke needs TOTP, run a separate enroll flow first.
- **No multi-operator seed.** One row is enough to drive the smoke. Per-operator onboarding is a v2 backlog item.

---

## Failure modes

### `[seed-staging-operator] probe failed: ...`

The Supabase service-role key is wrong, or the project URL is wrong. Re-check both from 1Password and re-run.

### `insert failed: ... 23505`

Unique violation on `email`. Another process inserted a row between the probe and the insert. Re-run the script — the second run will hit the update path.

### `insert failed: ... could not find ... in schema cache`

PostgREST has not loaded the `Operator` table into its schema cache yet. Wait 30 seconds, then re-run. If it persists, run §V.1 in the Supabase SQL editor — if the SELECT works there, PostgREST just needs a moment.

### The smoke still returns 500

Do not debug the seed in isolation. The seed is independent of the smoke: if V.1–V.3 pass and the row is in the table, the seed is correct. The 500 is almost certainly a different code path (Vercel env, Portal API, NextAuth) — escalate to the Backend Developer on [KAIA-1254](/KAIA/issues/KAIA-1254).

---

## To undo

The seed only writes one row. To remove it (and any session cookies for that operator become invalid):

```sql
delete from "Operator" where email = 'ops-staging@kairikos.com';
```

This is reversible in the sense that re-running the seed re-creates the row, but any in-flight operator sessions are gone.

---

## Change log

- **2026-06-16** — Initial runbook. One staging operator, argon2id, no TOTP, idempotent on `email`. Pairs with `portal/scripts/seed-staging-operator.ts`.
