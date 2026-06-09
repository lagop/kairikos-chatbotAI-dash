# Chatbot AI Portal — Schema & RLS

> Scope: [KAIA-731](/KAIA/issues/KAIA-731) — Supabase schema and per-tenant RLS
> for the end-client portal at `portal.kairikos.com`. Implements plan rev 2
> §4 + §4.1 of [KAIA-719](/KAIA/issues/KAIA-719#document-plan).

## Why this exists

Every read from `/portal/*` is JWT-scoped to a single client. The
`service_role` key is restricted to internal webhooks (n8n) and the
`/admin/portal/*` support view backend. The data model and RLS policies here
are the foundation for the rest of the portal workstream — endpoints
([KAIA-721](/KAIA/issues/KAIA-721)), frontend ([KAIA-733](/KAIA/issues/KAIA-733)),
automation ([KAIA-734](/KAIA/issues/KAIA-734)) and the QA cross-tenant isolation
test ([KAIA-725](/KAIA/issues/KAIA-725)) all depend on these tables and
policies being in place.

## Tables

| Table                  | Purpose                                                          | Writes from                | Reads from        |
| ---------------------- | ---------------------------------------------------------------- | -------------------------- | ----------------- |
| `chatbot_clients`      | One row per paying client. Billing + onboarding state machine.   | service_role (webhooks)    | portal + staff    |
| `chatbot_client_users` | Maps `auth.users.id` → `chatbot_clients.id` (v1: 1:1).            | service_role (signup flow) | portal + staff    |
| `chatbot_activity`     | T+N event timeline written by n8n.                               | service_role (n8n)         | portal + staff    |
| `chatbot_conversations`| Read-only in portal. Source for conversations list.              | service_role (n8n)         | portal + staff    |

### `chatbot_clients` key columns

- `slug` — stable human-readable identifier, unique, used in URLs and support.
- `tier` — `starter` | `pro` | `premium`, matches the Kairikos pricing tiers. Stripe remains the billing source of truth.
- `onboarding_status` — `pending` | `in_progress` | `live` | `paused` | `cancelled`. Drives the portal timeline view.
- `stripe_customer_id` — links to the Stripe customer record. Populated by the Stripe webhook handler.
- `chatbot_space_id`, `go_live_at` — set when the CTO finishes the operator-side provisioning step.

### `chatbot_client_users` key columns

- `user_id` — FK to `auth.users.id`. `unique (user_id)` enforces 1:1 in v1.
- `client_id` — FK to `chatbot_clients.id`.
- `role` — `owner` | `admin` | `viewer`. Set on invite; not editable from the portal in v1.

### `chatbot_activity` key columns

- `day_offset` — T+N day offset from intake. Negative allowed for pre-onboarding.
- `event_type` — checked enum; the 10 supported kinds cover the T+0/3/7/14 flow.
- `metadata` — `jsonb` for event-specific extras (QA result, transcript link, etc.).
- Index on `(client_id, occurred_at desc)` for the timeline view.

### `chatbot_conversations` key columns

- `external_id` — the chatbot platform's conversation id (e.g. Botpress).
- `channel` — `web` | `whatsapp` | `instagram` | `messenger` | `email` | `other`.
- `outcome` — `resolved` | `escalated` | `abandoned` | `fallback` | `unknown`.
- `escalated_to_human` — used to compute the "fallback / escalation rate" widget.
- Unique on `(client_id, external_id)` so n8n replays are idempotent.
- Partial index on `(client_id, outcome)` filtered to `escalated`/`fallback` for the support view.

## RLS policy design

The four tables all have:

1. `enable row level security`
2. `force row level security` — even the table owner is subject to RLS. This
   is critical: it prevents a future migration that grants a role as table
   owner from accidentally bypassing policies.

Two policy predicates per table:

- `*_select_own` — `id = public.chatbot_current_client_id()` (or `client_id =`).
  Backed by a `SECURITY DEFINER` helper that joins `auth.uid()` through
  `chatbot_client_users`. Returns the client id, or NULL when the user is not
  mapped (which causes the policy to deny by virtue of NULL = id).
- `*_select_staff` — `public.chatbot_is_staff()`. The helper reads
  `auth.jwt() -> 'app_metadata' ->> 'staff'`, which is set via the Supabase
  Auth admin API for operator accounts. End users can never set this claim on
  their own JWT (only service_role can edit `app_metadata`).

### What the service_role can do

`service_role` is **not** granted by a policy. In Supabase, the `service_role`
role bypasses RLS by design. The privilege grants on the four tables are
`select, insert, update, delete` for `service_role` so the role can do the
work n8n and the NestJS `/admin/portal/*` support view backend need.

This means the threat model is: **if the service_role key leaks, the RLS
guarantees are gone**. Mitigations (per plan rev 2 §7):

- service_role key is loaded from the secrets manager, never the frontend
  bundle. The frontend portal calls the NestJS API with the **client's**
  Supabase JWT, which the API then uses on the Supabase REST/PostgREST
  endpoint — never with service_role.
- service_role is used only by: the n8n T+N flows writing
  `chatbot_activity`/`chatbot_conversations`, the Stripe webhook handler
  writing `chatbot_clients` (subscription state), and the `/admin/portal/*`
  support view backend. All of those are server-side and audited.

### What the authenticated role can do

- `SELECT` on the four tables only. No insert/update/delete policies are
  defined for `authenticated`, so any write attempt is denied.
- Privileges are explicitly granted only on `SELECT` to `authenticated`; the
  `public` pseudo-role is revoked.

### What the anon role can do

Nothing. No grants to `anon` on these tables. Magic-link signup goes through
Supabase Auth, which never touches these tables directly — the NestJS backend
provisions the `auth.users` row and the `chatbot_client_users` mapping using
service_role after the user accepts the invite.

## Migrations

```
supabase/migrations/
  20260609_1200_001_create_chatbot_portal_tables.sql          # tables
  20260609_1200_001_create_chatbot_portal_tables.down.sql      # rollback
  20260609_1200_002_enable_rls_chatbot_portal.sql             # RLS + helpers
  20260609_1200_002_enable_rls_chatbot_portal.down.sql         # rollback
```

Apply order is the filename prefix (`001` before `002`). Each up migration
opens its own transaction.

### Reversibility

Each up migration has a `.down.sql` companion that:

- Drops the policies (idempotent `if exists`).
- Disables RLS (does not drop the tables — that would lose data).
- Re-grants the `authenticated`/`service_role` privileges at the same level
  the up migration left them, so a partial rollback (e.g. RLS removed but
  tables kept) still functions.
- Drops the helper functions.

To run a full rollback end-to-end, apply `.down` files in reverse order:
`002.down` → `001.down`.

## Acceptance test (psql smoke)

The RLS smoke is automated in `supabase/tests/chatbot_clients_rls_smoke.sql`.
The test simulates the acceptance criteria from the issue description by
calling the policies directly with `set local role` and `set local "request.jwt.claims"`.
Run with:

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/chatbot_clients_rls_smoke.sql
```

Expected output is documented in the test file itself; the test exits 0 on
success and non-zero on any failure.

## Seed data

`supabase/seeds/chatbot_clients_seed.sql` creates 2 fake clients — one fully
onboarded, one mid-onboarding — plus a small activity timeline and 5
conversation rows for the fully onboarded client. The seed is idempotent
(`ON CONFLICT DO NOTHING`) and is safe to re-run.

**Note:** the seed file references placeholder UUIDs for the `auth.users.id`
values. In a real environment, those rows must be created via the Supabase
Auth admin API first; replace the placeholders in the `chatbot_client_users`
inserts with the real user UUIDs.

## What this PR does NOT do

- No application code (NestJS endpoints). That's [KAIA-721](/KAIA/issues/KAIA-721).
- No frontend changes. That's [KAIA-733](/KAIA/issues/KAIA-733).
- No automation flow changes. That's [KAIA-734](/KAIA/issues/KAIA-734).
- No staff-account provisioning. The `staff` claim is set on the `auth.users`
  row via Supabase Auth admin; that's a small one-time task, not part of
  this issue.

## Open follow-ups for [KAIA-721](/KAIA/issues/KAIA-721)

- The NestJS /portal/* module should call Supabase REST/PostgREST with the
  client's `apikey` + `Authorization: Bearer <user-jwt>` so the per-tenant
  policies above do the row scoping server-side. The API should never hold
  a service_role key in memory for portal read paths.
- The signup flow (the one that creates the `auth.users` row and the
  matching `chatbot_client_users` mapping) is owned by the NestJS
  `/portal/signup` endpoint and the Supabase Auth admin API. It must be the
  only path that writes to `chatbot_client_users`.
