# Operator smart notifications — n8n ↔ portal (KAIA-1061)

> **Owner:** Automation Engineer
> **Target stack:** Kairikos Chatbot AI end-client portal (Next.js 14 +
> Prisma + PostgreSQL 16, KAIA-752 / KAIA-723).
> **Companion code:** `portal/src/app/api/internal/notify-operator/route.ts`,
> `portal/src/lib/operator-notify.ts`, `portal/prisma/schema.prisma`
> (the new `OperatorNotification` model + `@@unique([clientId, kind, day])`
> constraint).

This runbook is the source of truth for the contract between the n8n
operator-notification flows and the portal's
`POST /api/internal/notify-operator` endpoint. The contract is
_idempotent_: re-running the same flow on the same day for the same
client never produces a duplicate email or duplicate row.

---

## 1. Goals and non-goals

**Goals**

- Operator gets a Resend email when (a) a client has been silent for
  >N hours, (b) an n8n execution failed, (c) T+7 escalation is required.
- The same `(clientId, kind, day)` pair never produces a duplicate
  email — the `OperatorNotification` table's unique constraint is the
  source of truth.
- Authentication is a shared secret between n8n and the portal — no
  NextAuth, no magic-link, no per-user flow.
- Failure modes are explicit: missing key, bad body, unknown client,
  database error, Resend error, missing operator email — all surface
  as 4xx/5xx with a JSON body the n8n workflow can read.

**Non-goals**

- Operator intervention actions (KAIA-1059 — sibling issue).
- Operator flow-health visibility (KAIA-1060 — sibling issue).
- Client self-service UI (KAIA-1062 — sibling issue).
- Per-tenant opt-out (the allowlist is global; a per-tenant toggle
  needs a future schema change tracked separately).

---

## 2. The three notification kinds

| Kind                | When it fires                                          | Required fields                                              | Default trigger                              |
|---------------------|--------------------------------------------------------|--------------------------------------------------------------|----------------------------------------------|
| `stuck`             | Client has no `ChatbotActivity` row in the last 24h    | `clientId`, `milestone`, `hoursSince`                         | Hourly cron (`0 * * * *`)                    |
| `execution-failed`  | Any n8n execution in this workspace errors              | `executionId`, `workflowName`, `error` (`clientId` optional)  | n8n `errorTrigger` (sibling workflow)        |
| `escalation`        | T+7 milestone reached and no escalation row recorded   | `clientId`, `reason` (`status` optional)                     | Daily cron (`0 9 * * *` UTC)                 |

`clientId` is **required** for `stuck` and `escalation` (the operator
needs to know which client to call). It is **optional** for
`execution-failed` — a non-client-scoped n8n failure still alerts the
operator, just with a synthetic `__unassigned__` dedup key.

---

## 3. The `OperatorNotification` contract

The Prisma model lives in `portal/prisma/schema.prisma`. n8n writes
against it through the internal endpoint with the following shape:

| Field             | Type    | Source in n8n                                              |
|-------------------|---------|------------------------------------------------------------|
| `clientId`        | uuid?   | Resolved from the workflow context (Tally / Stripe / supabase UUID → cuid via `/api/internal/lookup-client`). NULL for unassigned events. |
| `kind`            | text    | One of `stuck` / `execution-failed` / `escalation` (enforced server-side; see route). |
| `day`             | text    | UTC date in `YYYY-MM-DD` form. Computed server-side.        |
| `subject`         | text    | Email subject, derived from the template.                  |
| `context`         | text?   | JSON-as-string with the request body that fired the notification. |
| `resendMessageId` | text?   | Populated by the route after a successful Resend send. NULL when skipped or deduped. |
| `sentAt`          | timestamp | Defaults to `now()` on insert.                             |

The unique constraint `@@unique([clientId, kind, day])` is the
idempotency guarantee: repeated calls within the same UTC day collapse
to a no-op. `day` is timezone-stable (UTC), so a client in Madrid
firing at 23:59 local and 00:01 local the next day are still two
separate dedup buckets, both labeled by their UTC date.

### 3.1 Endpoint and auth

```
POST  {PORTAL_API_URL}/api/internal/notify-operator
Headers:
  Content-Type:              application/json
  X-Kairikos-Internal-Key:   ${PORTAL_API_KEY}
Body:
  {
    "kind": "stuck" | "execution-failed" | "escalation",
    "clientId": "<uuid>" | null,
    // kind-specific (see §2)
    "milestone": "T+3", "hoursSince": 26,
    // OR
    "executionId": "exec_1", "workflowName": "T+0", "error": "...",
    // OR
    "reason": "...", "status": "overdue"
  }
```

`PORTAL_API_KEY` is the same env var on both sides: n8n credential
vault + Vercel/secret store. **Never** commit a real value. **Never**
log the value. The portal compares the header with
`crypto.timingSafeEqual` (see `src/lib/internal-auth.ts`).

### 3.2 Response shape

```jsonc
{
  "ok": true,
  "deduped": false,
  "id": "<cuid>",
  "kind": "stuck",
  "clientId": "<uuid>",
  "day": "2026-06-12",
  "sentAt": "2026-06-12T13:45:00.000Z",
  "resendMessageId": "<resend id>"
}
```

`deduped: true` means an `OperatorNotification` row for the same
`(clientId, kind, day)` already existed — the operator was already
emailed today, so we skipped the Resend call and returned the
existing row.

### 3.3 Error responses

| Status | `error`                  | When                                                       | What n8n should do               |
|--------|--------------------------|------------------------------------------------------------|----------------------------------|
| 400    | `bad_request`            | Missing/invalid kind, missing kind-specific fields, etc.   | Log; do NOT retry.               |
| 401    | `unauthorized`           | Missing or wrong `X-Kairikos-Internal-Key` header.         | Alert (key rotation issue).      |
| 404    | `not_found`              | `clientId` does not match any `ChatbotClient` row.         | Log; do NOT retry.               |
| 500    | `server_misconfigured`   | `PORTAL_API_KEY` env var missing on the portal.            | Alert (deploy issue).            |
| 500    | `operator_not_configured`| `KAIRIKOS_OPERATOR_EMAILS` env var missing or empty.       | Alert (deploy issue).            |
| 502    | `resend_send_failed`     | Resend SDK returned an error.                              | Log; do NOT retry (would still be deduped but the row needs manual review). |
| 503    | `database_not_configured`| `DATABASE_URL` env var missing on the portal.             | Alert (deploy issue).            |

### 3.4 Idempotency mechanics

- The portal has `@@unique([clientId, kind, day])` on
  `OperatorNotification`.
- The route does a `findUnique` on the unique pair first, then an
  `upsert` (create-on-first / update-on-retry). The route's `update`
  branch intentionally **does not** overwrite `resendMessageId` —
  the first send wins so the operator always references the same
  Resend message id when looking up delivery state.
- Repeated n8n retries within the same UTC day collapse to a no-op.
  The `subject` and `context` get refreshed on retry, but
  `resendMessageId` is preserved.

---

## 4. n8n flows

The three flows live in this folder as importable JSON:

| File                     | Trigger              | When to enable                              |
|--------------------------|----------------------|---------------------------------------------|
| `stuck.json`             | Schedule (hourly)    | Always.                                     |
| `execution-failed.json`  | Error trigger        | Always. Link as a sibling to the T+N flows. |
| `escalation.json`        | Schedule (daily 9am) | Always.                                     |

Generate them with `npx tsx automations/operator-notifications/build-flows.ts`
and import via **n8n → Workflows → Import from File**. Set
`PORTAL_API_URL` and `PORTAL_API_KEY` in the n8n credential vault before
activating.

The portal does the dedup — n8n just needs to emit one event per
client per kind. The build script's `Build Notify Payload` node
defines the exact field mapping; update there if the schema evolves.

### 4.1 Environment variables (n8n side)

```
PORTAL_API_URL        # e.g. https://portal.kairikos.com
PORTAL_API_KEY        # shared with the portal env store
```

### 4.2 Environment variables (portal side)

```
PORTAL_API_KEY                 # shared with n8n vault
RESEND_API_KEY                 # Resend SDK key (server-only)
KAIRIKOS_OPERATOR_EMAILS       # comma-separated, required
KAIRIKOS_NOTIFY_KINDS          # optional allowlist (default: all)
OPERATOR_NOTIFY_FROM           # optional From override
NEXT_PUBLIC_PORTAL_URL         # used in email templates
```

The portal fails closed (500 `operator_not_configured`) when
`KAIRIKOS_OPERATOR_EMAILS` is empty — sending nothing when the
operator was expecting an alert is the worse failure mode.

---

## 5. Operator opt-out (allowlist)

`KAIRIKOS_NOTIFY_KINDS` is a comma-separated allowlist of kinds that
are allowed to fire. If unset (or empty), all kinds are allowed.

```
# silence execution-failed alerts
KAIRIKOS_NOTIFY_KINDS=stuck,escalation
```

Unset the env var to re-enable. The allowlist applies **after** auth
and validation, so a request that would otherwise be rejected still
returns a 4xx (no information leak through the allowlist branch).

---

## 6. Local dev

```bash
# 1. Apply the new migration.
cd portal
DATABASE_URL="postgresql://..." npx prisma migrate deploy

# 2. Run the unit + smoke tests (no live HTTP, no DB).
npm run test:unit -- tests/unit/operator-notify.test.ts
npx tsx scripts/smoke-notify-operator.ts

# 3. Hit the route with a real key + email env (locally the Resend
#    call is skipped; the route persists the row and returns
#    `{ skipped: 'no_api_key' }`).
PORTAL_URL=http://localhost:3001 \
PORTAL_API_KEY=dev-key \
KAIRIKOS_OPERATOR_EMAILS=ops@example.com \
npx playwright test tests/specs/notifications.spec.ts --grep @smoke
```

In dev with no `RESEND_API_KEY` the route does not send email; it
still validates, dedupes, and persists a row with `resendMessageId:
null`. The operator never sees the email, but the dedup log is intact
for the next time the production env is in play.

---

## 7. Acceptance criteria (from KAIA-1061)

- [x] Operator gets a Resend email when a client is stuck for >24h.
- [x] Operator gets a Resend email when an n8n execution fails.
- [x] Operator gets a Resend email when T+7 escalation fires.
- [x] Deduplication works: same kind does not fire twice in 24h for
      the same client (`@@unique([clientId, kind, day])`).
- [x] `OperatorNotification` table exists and is queryable
      (`prisma.operatorNotification.*`).
- [x] The 3 Resend templates are covered by unit + smoke tests.
- [x] Smoke test added at `tests/specs/notifications.spec.ts`
      (Playwright, gated by `@smoke`).

## 8. Definition of done

- 3 notification kinds work end-to-end (n8n → portal API → Resend →
  operator inbox).
- Deduplication works.
- Email templates are reviewed (3 unit tests assert subject / body
  shape per kind; HTML escaping is verified).
- Operator can opt out per kind via `KAIRIKOS_NOTIFY_KINDS`.

---

## 9. Reusability

The contract (POST `/api/internal/notify-operator` + the
`OperatorNotification` table) is generic and re-usable across future
Kairikos clients — when the next chatbot client onboards, the same
flow JSON imports straight into a new n8n workspace; only the
`PORTAL_API_URL` and `PORTAL_API_KEY` change. The templates are
per-Kind and have no per-client hard-coding.

---

## 10. Execution capture (KAIA-1073) — stuck-monitor

> **Companion contract:** `portal/src/app/api/internal/n8n-execution/route.ts`
> and the `N8nExecution` Prisma model.

The operator flow-health dashboard ([KAIA-1060](/KAI/issues/KAIA-1060))
shows the **last n8n run status** for each client. To make that
column live, the stuck-monitor flow (`stuck.json`) records its own
execution row by calling `POST /api/internal/n8n-execution` from a
dedicated `Report Execution to Portal (KAIA-1073)` HTTP Request node.

The node is wired in **both branches**:

- **Success path**: `Log Result` → `Report Execution` (records
  `status: "success"`, captures the resolved `clientId` from
  `Build Notify Payload` for traceability).
- **Error path**: any upstream node's `error` output also fans into
  `Report Execution` (records `status: "failed"`, `errorCode`,
  `errorMessage`).
- The node uses `options.response.neverError: true` so a portal
  outage does **not** cascade into a stuck-monitor failure.

The route is **idempotent on `id`** — every n8n execution has a
unique `execution.id`, so repeated retries of the same run collapse
to a single `N8nExecution` row in the portal. The dashboard reads
this table; the operator sees real status, not `'unknown'`.

### 10.1 Request body shape

The body is built inside the HTTP Request node's `body` expression
(uses `$execution` and the upstream `Build Notify Payload` context):

```jsonc
{
  "id": "<n8n execution.id>",
  "clientId": "<uuid|null>",
  "clientName": null,
  "workflow": "Operator Notify — stuck",
  "milestone": "<T+0|T+3|T+7|T+14|null>",
  "status": "success" | "failed",
  "startedAt": "<ISO-8601 from $execution.startedAt>",
  "finishedAt": "<now>",
  "errorCode": "<string|null, max 100>",
  "errorMessage": "<string|null, max 4000>"
}
```

### 10.2 Coverage of all three operator-notify flows

All three operator-notify flows (KAIA-1080) end with the same
`Report Execution to Portal (KAIA-1073)` node, wired on both
success and error branches. The build script
(`build-flows.ts`) generates all three:

| Flow                    | `workflow` literal in the row  | `milestone` per row                          |
|-------------------------|--------------------------------|----------------------------------------------|
| `stuck.json`            | `Operator Notify — stuck`      | From `Build Notify Payload.input.milestone`  |
| `execution-failed.json` | `Operator Notify — execution-failed` | `null` (the error trigger fires for any T+N; we don't know which) |
| `escalation.json`       | `Operator Notify — escalation` | `T+7`                                        |

The `execution-failed` flow's own `Report Execution` call is
**not** a feedback loop: it records the *act of notifying* that
a downstream workflow failed, not the downstream failure itself.
The two rows sit side-by-side in the `N8nExecution` table — one
for the failing T+N run (written by the T+N flow's own
`Report Execution` node) and one for the operator-alert run
(written by the execution-failed flow's `Report Execution`
node).

### 10.3 Credential set

The `Report Execution` node reads `PORTAL_API_KEY` from the n8n
env vars, not from a credential. The dedicated credential set
for the portal-internal writes is documented in the sibling
README at `automations/portal-internal-activity/README.md` §9.6
(`KAIRIKOS_PORTAL_INTERNAL`); the operator rotates that single
credential when [KAIA-1075](/KAI/issues/KAIA-1075) lands.
