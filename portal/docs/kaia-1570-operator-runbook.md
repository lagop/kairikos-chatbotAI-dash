# KAIA-1570 — Operator runbook: reconcile staging Supabase schema with portal Prisma

**Audience:** the operator who can reach the Supabase dashboard
**Owner:** CTO ([2f1efc73-463d-478c-98db-e2af8746f170](https://www.paperclip.local/KAIA/agents/cto))
**Last updated:** 2026-06-16
**Status:** ready to apply
**Blast radius:** staging DB only (`ikexqreuvoqwvwopftkt`). The reconciliation is additive and idempotent; it does NOT touch the Botpress-side snake_case tables (`chatbot_clients`, `chatbot_client_users`, `chatbot_activity`, `chatbot_conversations`).

---

## TL;DR

1. Open the Supabase SQL editor for project `ikexqreuvoqwvwopftkt`.
2. Paste the contents of [`20260616180000_reconcile_staging_schema.up.sql`](/paperclip/instances/default/projects/fe217b5c-badf-4f17-ab20-f089478a35c7/bbe7754b-a8a8-4e1d-86b6-8cbbc4cfa3a4/_default/supabase/migrations/20260616180000_reconcile_staging_schema.up.sql) into a new query.
3. Run it. Expected: "Success. No rows returned" (DDL only).
4. Run the **Post-reconcile verification** block below.
5. Reply on [KAIA-1570](/KAIA/issues/KAIA-1570) with the verification output and a green ✅.
6. The CTO will then unblock the QA smokes ([KAIA-1254](/KAIA/issues/KAIA-1254) through [KAIA-1258](/KAIA/issues/KAIA-1258)) and the wizard umbrella ([KAIA-1161](/KAIA/issues/KAIA-1161)).

Total time: 5 minutes (mostly waiting for the Supabase query runner).

---

## Why this exists

The portal backend's Prisma client (KAIA-752) reads and writes a set of tables with **PascalCase names** (`ChatbotClient`, `ChatbotClientUser`, `Operator`, `ChatbotConfigStep`, etc.) — see `portal/prisma/schema.prisma`. The live staging DB at `ikexqreuvoqwvwopftkt` only has the **snake_case Botpress-side tables** (`chatbot_clients`, `chatbot_client_users`, `chatbot_activity`, `chatbot_conversations`).

The 13 Prisma migrations under `portal/prisma/migrations/*` were never applied to staging. Past attempts (KAIA-1435, KAIA-1472) failed with `Network is unreachable` from the agent runtime to `db.ikexqreuvoqwvwopftkt.supabase.co:5432`. This script materializes every portal Prisma table that the live DB is missing, **idempotently**, so the portal Prisma client can finally read and write the staging DB.

**What we do NOT do**, by design:

- We do not touch the snake_case Supabase tables. Those are owned by the Botpress side of the stack.
- We do not rename or remap the PascalCase portal tables to snake_case. The portal Prisma client depends on the exact PascalCase identifiers (no `@map` in `schema.prisma`).
- We do not enable RLS on the new portal tables. The portal uses the Supabase `service_role` key server-side, which bypasses RLS, and the magic-link signin flow on the client uses the anon key without ever reading the portal Prisma tables.

This is **Path A** from the issue body: additive, non-destructive, idempotent, reversible.

---

## How to apply

### Step 1 — Open the SQL editor

Go to: <https://supabase.com/dashboard/project/ikexqreuvoqwvwopftkt/sql/new>

(Requires Supabase dashboard access for the `ikexqreuvoqwvwopftkt` project. If you don't have it, escalate to the CEO.)

### Step 2 — Paste the up migration

Open the file in your editor of choice:

```text
/paperclip/instances/default/projects/fe217b5c-badf-4f17-ab20-f089478a35c7/bbe7754b-a8a8-4e1d-86b6-8cbbc4cfa3a4/_default/supabase/migrations/20260616180000_reconcile_staging_schema.up.sql
```

Copy the full file contents (it is ~430 lines, ends with `commit;`). Paste it into the Supabase SQL editor.

### Step 3 — Run

Click **Run** in the Supabase editor. The script is one transaction; either the whole thing succeeds or nothing changes.

Expected output: a single "Success. No rows returned" line. The script is DDL-only (no `INSERT`s, no `SELECT`s that return rows), so the query result pane is empty.

If you see any error, **stop and ping the CTO on [KAIA-1570](/KAIA/issues/KAIA-1570) with the full error text**. Do not try to debug it on the spot — the script is meant to be safe to re-run, and a partial failure means the transaction rolled back.

### Step 4 — Post-reconcile verification

Run each of these one at a time in the Supabase SQL editor (open a **new** query for each, so you can read the output). They check that every portal Prisma table the backend needs now exists, and that no pre-existing snake_case table was touched.

#### 4.1 — All portal Prisma tables now exist

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'ChatbotClient',
    'ChatbotClientUser',
    'ChatbotActivity',
    'ChatbotConversation',
    'Account',
    'Session',
    'VerificationToken',
    'Operator',
    'OperatorSession',
    'OperatorRecoveryCode',
    'OperatorSettings',
    'OperatorSettingsAudit',
    'OperatorNotification',
    'N8nExecution',
    'ChatbotConfigStep',
    'ChatbotConfigStepAudit'
  )
order by table_name;
```

**Expected:** 16 rows. If you see fewer than 16, the reconcile migration did not complete; ping the CTO with the count and which names are missing.

#### 4.2 — The snake_case Supabase tables are untouched

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'chatbot_clients',
    'chatbot_client_users',
    'chatbot_activity',
    'chatbot_conversations'
  )
order by table_name;
```

**Expected:** 4 rows. **Do not** check column shape here — these tables are owned by the Botpress side and we did not touch them.

#### 4.3 — ChatbotClient has the columns the Prisma client queries

```sql
select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name   = 'ChatbotClient'
order by ordinal_position;
```

**Expected (in this order):** `id (text)`, `email (text)`, `name (text)`, `companyName (text)`, `tier (text)`, `stripeCustomerId (text)`, `state (text)`, `goLiveAt (timestamp without time zone)`, `supabaseClientId (text)`, `createdAt (timestamp without time zone)`, `updatedAt (timestamp without time zone)`.

If a column is missing, the Prisma client will 500 on the first query that touches it.

#### 4.4 — ChatbotClientUser has nextAuthEmail

```sql
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name   = 'ChatbotClientUser'
order by ordinal_position;
```

**Expected (in this order):** `id (text, NO)`, `clientId (text, YES)`, `nextAuthEmail (text, NO)`.

The `nextAuthEmail` column is the one the QA smoke at [KAIA-1254](/KAIA/issues/KAIA-1254) was 500-ing on. If it is not present, the migration failed silently on a partial state — escalate immediately.

#### 4.5 — Lifecycle functions are present

```sql
select proname, pronargs
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in (
    'business_hours_elapsed',
    'operator_day_in_tz',
    'wizard_abandoned_window'
  )
order by proname;
```

**Expected:** 3 rows.

#### 4.6 — The partial UNIQUE on activeForBot is in place

```sql
select indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename  = 'ChatbotConfigStep'
  and indexname  = 'ChatbotConfigStep_activeForBot_partial_uniq';
```

**Expected:** one row. The `indexdef` should reference `WHERE ("activeForBot" = true)`. The bot config loader relies on this invariant (KAIA-1163 / BE-1 v1).

### Step 5 — End-to-end smoke

The CTO will re-run the operator login flow from a heartbeat after you post the green ✅. The expected chain is:

1. `POST /api/operator/login` (with the seeded operator credentials — see below) returns 200 instead of 500.
2. `POST /api/portal/login` (magic-link) still redirects to NextAuth (this is unrelated to the schema; it has always worked).
3. The Playwright happy-path for [KAIA-1254](/KAIA/issues/KAIA-1254) gets past the first DB call.

If you want to do a quick local check before posting the ✅, the operator login endpoint is at:

```bash
curl -sS -X POST https://project-fxidg.vercel.app/api/operator/login \
  -H "Content-Type: application/json" \
  -d '{"email":"staff-test@kairikos.dev","password":"<the password the CTO or Backend Developer gave you>"}'
```

**Expected (after the reconciliation):** HTTP 200 with `{"totpRequired":false}`. **If you don't have the seeded operator's password**, skip this step — the CTO will do the end-to-end check.

### Step 6 — Post the green ✅

Reply on [KAIA-1570](/KAIA/issues/KAIA-1570) with the verification output from §4.1 through §4.6 and the result of §5 if you ran it.

The CTO will:

1. Re-run the verification queries from a heartbeat to confirm independently.
2. Drive [KAIA-1254](/KAIA/issues/KAIA-1254) to `done` if §5 passes, or call out the next failure if it doesn't.
3. Mark [KAIA-1570](/KAIA/issues/KAIA-1570) `done` and close the unblock chain.

---

## If something goes wrong

### The migration raised an error

Stop. The script is in a `begin; ... commit;` block, so a failure mid-transaction rolls everything back. Re-run from Step 2 — the script is idempotent. If it still fails on the second run, ping the CTO with the exact error.

### The verification shows fewer than 16 portal Prisma tables

The transaction may have committed partially if the Supabase editor handled the `commit;` differently than a `psql` client. The script uses `if not exists` guards, so you can re-run the whole up script again and it will fill in the missing tables.

### The reconcile broke a Botpress flow

This should be impossible — the script does not touch the snake_case tables, and the snake_case tables do not have any cross-FK to the PascalCase tables. If you see a Botpress flow error after the reconciliation, escalate to the CTO **without** running the rollback — the cause is almost certainly somewhere else (an n8n flow, a Botpress webhook, etc.).

### You need to undo the reconciliation

Open a new SQL query and run the contents of:

```text
/paperclip/instances/default/projects/fe217b5c-badf-4f17-ab20-f089478a35c7/bbe7754b-a8a8-4e1d-86b6-8cbbc4cfa3a4/_default/supabase/migrations/20260616180000_reconcile_staging_schema.down.sql
```

Expected: drops the 16 portal Prisma tables + 3 functions in reverse dependency order. The snake_case Botpress tables stay. If you need to run it, **first** ping the CTO on [KAIA-1570](/KAIA/issues/KAIA-1570) so we can capture the reason — a rollback is a one-way door in practice (any seeded operator rows, any active session cookies, any draft wizard steps are lost).

---

## Post-rollback verification (only if § "If something goes wrong" → rollback applies)

```sql
-- Should be 0 portal Prisma tables, but the 4 snake_case tables still there.
select 'pascal'  as kind, count(*) as n from information_schema.tables
  where table_schema = 'public' and table_name in (
    'ChatbotClient','ChatbotClientUser','ChatbotActivity','ChatbotConversation',
    'Account','Session','VerificationToken','Operator','OperatorSession',
    'OperatorRecoveryCode','OperatorSettings','OperatorSettingsAudit',
    'OperatorNotification','N8nExecution','ChatbotConfigStep','ChatbotConfigStepAudit'
  )
union all
select 'snake'   as kind, count(*) as n from information_schema.tables
  where table_schema = 'public' and table_name in (
    'chatbot_clients','chatbot_client_users','chatbot_activity','chatbot_conversations'
  );
```

**Expected (post-rollback):** `pascal | 0`, `snake | 4`.

---

## Change log

- **2026-06-16 18:00Z** — Initial runbook created by the CTO. One-shot apply via the Supabase SQL editor. No changes to Botpress-side tables. Idempotent up + down migrations.
