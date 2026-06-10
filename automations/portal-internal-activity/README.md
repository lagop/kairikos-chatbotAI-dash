# Portal Internal Activity — n8n T+0/3/7/14 flows (KAIA-756)

> **Owner:** Automation Engineer
> **Target stack:** Kairikos Chatbot AI end-client portal (Next.js 14 + Prisma
> + PostgreSQL 16, KAIA-752 / KAIA-723).
> **Companion code:** `portal/src/app/api/internal/activity/route.ts`,
> `portal/src/lib/internal-auth.ts`, `portal/prisma/schema.prisma` (the new
> `@@unique([clientId, milestone])` constraint).

This runbook is the source of truth for the contract between the n8n
T+0 / T+3 / T+7 / T+14 onboarding email flows and the portal's
`POST /api/internal/activity` endpoint. Every new internal writer
(operator actions, future Stripe-driven events) **must** follow this
contract — copy the existing workflow exports as the starting point.

---

## 1. Goals and non-goals

**Goals**

- Every T+N email send writes exactly one `ChatbotActivity` row that the
  portal onboarding timeline can render.
- Re-running the same workflow on the same client never produces a
  duplicate row (idempotent upsert on the unique `(clientId, milestone)`
  pair).
- Authentication is a shared secret between n8n and the portal — no
  NextAuth, no magic-link, no per-user flow.
- Failure modes are explicit: missing key, bad body, unknown client,
  database error, network error — all surface as 4xx/5xx with a JSON
  body the n8n Slack alert can read.

**Non-goals**

- Reading the activity back. The portal uses the public `ChatbotActivity`
  Prisma model directly (`/api/portal/onboarding`); the internal route
  is write-only.
- The previous Supabase-targeted `automations/t-plus-onboarding/` flows
  (KAIA-734) are now superseded. They targeted the Supabase `chatbot_activity`
  table — the wrong stack for the rev 3 portal. The next step is a
  follow-up issue to retire those flows.
- Status-change writes are out of scope for this issue. The
  `automations/portal-timeline/status-change-watcher.json` from
  KAIA-734 still targets Supabase; it needs a parallel update against
  `/api/internal/activity`. Track as a follow-up child issue.

---

## 2. The `ChatbotActivity` contract (consumed by n8n)

The Prisma model is owned by [KAIA-752](/KAIA/issues/KAIA-752)
(`portal/prisma/schema.prisma`). n8n must write against it through the
internal endpoint with the following shape:

| Field         | Type   | Source in n8n                                                                                            |
|---------------|--------|-----------------------------------------------------------------------------------------------------------|
| `clientId`    | uuid   | Resolved from the Tally intake payload or Stripe customer lookup (see §3).                                |
| `milestone`   | text   | One of `T+0`, `T+3`, `T+7`, `T+14`, `status_change` (enforced server-side; see route).                    |
| `completedAt` | ISO-8601 string | `new Date().toISOString()` at the moment the email send succeeds.                                |
| `notes`       | text   | Free-form JSON-as-string with `email_subject`, `send_status`, `provider`, `email_message_id`, `template`, `locale`. |

The unique constraint `(clientId, milestone)` makes the endpoint a
true upsert — repeated writes from n8n retries collapse to a no-op
without producing duplicate rows.

### 2.1 Endpoint and auth

```
POST  {PORTAL_API_URL}/api/internal/activity
Headers:
  Content-Type:            application/json
  X-Kairikos-Internal-Key: ${PORTAL_API_KEY}
Body:
  { "clientId": "<uuid>", "milestone": "T+0", "completedAt": "<ISO-8601>", "notes": "<text|null>" }
```

`PORTAL_API_KEY` is the same env var on both sides: it lives in the
n8n credential vault for the workflow, and in Vercel/secret store for
the portal. **Never** commit a real value. **Never** log the value.

The portal compares the header value with `crypto.timingSafeEqual` (see
`src/lib/internal-auth.ts`) and refuses to start the route if the env
var is unset. Length-mismatched inputs still pay the constant-time
cost — the response time does not leak the secret length.

### 2.2 Idempotency mechanics

- The portal has `@@unique([clientId, milestone])` on `ChatbotActivity`.
- The Prisma client uses `upsert` keyed on that unique pair.
- Repeated writes with the same `(clientId, milestone)` update the
  existing row in place (`completedAt` and `notes` get refreshed).
- The same workflow re-run after a transient failure therefore
  produces exactly one row, with the most recent `completedAt` /
  `notes`.

### 2.3 Error responses

| Status | `error`                | When                                                       | What n8n should do             |
|--------|------------------------|------------------------------------------------------------|--------------------------------|
| 401    | `unauthorized`         | Missing or wrong `X-Kairikos-Internal-Key` header.         | Alert (key rotation issue).    |
| 400    | `bad_request`          | Body is not valid JSON or fails the validation rules.      | Fix payload; do not retry.     |
| 404    | `not_found`            | `clientId` does not match a `ChatbotClient` row.           | Alert (client onboarding gap). |
| 500    | `database_error`       | Prisma error (e.g. unique-constraint violation, FK error). | Retry with backoff.            |
| 500    | `server_misconfigured` | `PORTAL_API_KEY` is unset on the server.                   | Alert (operator must fix).     |
| 503    | `database_not_configured` | `DATABASE_URL` unset (test env, not a deploy).          | Alert; do not retry.           |

n8n's HTTP Request node already retries on transient network errors.
The route returns clear JSON bodies so the Slack alert node can read
the `error` and `detail` fields.

---

## 3. Resolving `clientId` from a Tally intake payload

The T+0 flow receives a Tally webhook like:

```json
{
  "eventId": "ev_abc",
  "eventType": "form_response",
  "formId": "<tally-form-id>",
  "fields": [
    { "key": "email", "value": ["cliente@empresa.com"] },
    { "key": "company_name", "value": ["Peluquería Aurora"] }
  ]
}
```

The n8n flow then calls a sibling internal route to resolve the
`ChatbotClient` id from the email:

```
POST  {PORTAL_API_URL}/api/internal/lookup-client
Headers:
  Content-Type:            application/json
  X-Kairikos-Internal-Key: ${PORTAL_API_KEY}
Body:
  { "email": "cliente@empresa.com" }
```

Response: `{ "clientId": "<uuid>", "companyName": "...", "contactEmail": "..." }`.

> ⚠️ The `lookup-client` route is **not** part of KAIA-756. It is
> referenced here so the n8n flows are importable as-is. Build it as a
> follow-up child issue (`POST /api/internal/lookup-client`) — it is a
> 20-line read-only Prisma `findUnique` against `ChatbotClient.email`
> with the same `PORTAL_API_KEY` check. Tracking in
> [KAIA-756 follow-ups](#7-follow-ups).

---

## 4. The four workflows

| File                                                | Trigger                          | Emits               |
|-----------------------------------------------------|----------------------------------|---------------------|
| `t-0-portal.json`                                   | Tally webhook (intake form)      | `T+0`               |
| `t-3-portal.json`                                   | Schedule (T+3 after intake)      | `T+3`               |
| `t-7-portal.json`                                   | Schedule (T+7 after intake)      | `T+7`               |
| `t-14-portal.json`                                  | Schedule (T+14 after intake)     | `T+14`              |

Each file is a complete n8n workflow export (importable via the n8n
UI: *Workflows → Import from File*). Regenerate with
`npx tsx automations/portal-internal-activity/build-flows.ts` after
editing the spec.

### 4.1 Generic node shape (every T+N workflow)

```
[ Trigger: Webhook (T+0) | Schedule (T+N) ]
   ↓
[ 1. Verify Webhook Signature ]            HMAC-SHA256
   ↓
[ 2. Resolve Client (Prisma) ]             POST /api/internal/lookup-client
   ↓
[ 3. Send T+N Email (Resend) ]             existing email node, unchanged
   ↓
[ 4. Write Activity to Portal ]            POST /api/internal/activity
   ↓
[ 5. Notify Slack on Error ]               error branch only, never silent
```

The email is sent **before** the activity write. If the email fails
the activity row is not written (the workflow errors out at node 3
and node 4 is never reached). If the email succeeds but the activity
write fails, n8n retries; the portal's unique constraint keeps the
second attempt safe.

---

## 5. Credentials and secrets

Stored in the n8n credential vault and the Vercel/secret store for
the portal. **Never in workflow JSON or comments.**

- `PORTAL_API_URL` — portal base URL (`https://portal.kairikos.com` in
  prod).
- `PORTAL_API_KEY` — shared secret for the `X-Kairikos-Internal-Key`
  header on `/api/internal/*`. **Same value on both sides.**
- `RESEND_API_KEY` — the existing Resend API key for the T+N email
  sends.
- `SLACK_WEBHOOK_URL` (or n8n Slack credential) — for the error branch.
- `N8N_WEBHOOK_SHARED_SECRET` — HMAC secret for the Tally intake
  signature.

If `PORTAL_API_KEY` is missing on either side, the workflows must be
left `BLOCKED` and the Automation Engineer tags the CEO with the exact
env var name (per role guide).

---

## 6. Test plan

Owner: Automation Engineer. Pre-req: Backend's seed script
(`prisma/seed.ts`) has loaded 2 fake clients (`aurora@example.com`,
`rios@example.com`).

1. **Smoke** — run `node --experimental-strip-types
   portal/scripts/smoke-internal-activity.ts` from the project root.
   Asserts 20 cases: constant-time auth (5), body validation (5),
   idempotent upsert (10). All should pass before the workflow is
   imported into n8n.
2. **Happy path.** Trigger the T+0 webhook with the Aurora intake
   payload (use `x-kairikos-dev-email: aurora@example.com` or a real
   magic-link JWT). Assert one `ChatbotActivity` row exists with
   `milestone='T+0'`, `completedAt` close to now.
3. **Idempotency.** Re-trigger the T+0 flow with the same payload.
   Assert exactly one row (count unchanged), and the row's
   `completedAt`/`notes` reflect the **most recent** write.
4. **Bad key.** Trigger the flow with an invalid
   `X-Kairikos-Internal-Key`. Assert 401 + Slack alert.
5. **Bad payload.** Trigger with `clientId: "not-a-uuid"`. Assert 400
   + Slack alert.
6. **Unknown client.** Trigger with a valid UUID that does not exist
   in `ChatbotClient`. Assert 404 + Slack alert.
7. **Timeline render.** Log into the portal as the Aurora client JWT
   and assert the timeline shows the new `T+0` row.

The test plan is also what the QA agent runs end-to-end (KAIA-757)
against staging.

---

## 7. Follow-ups

These are the next steps the Automation Engineer is tracking on this
issue. None block the current deliverable.

1. **POST `/api/internal/lookup-client`** — a sibling internal route
   for the n8n flows to resolve `clientId` from `email`. 20 lines of
   Prisma + the same `PORTAL_API_KEY` check. Build as a child issue
   under KAIA-756.
2. **Retire `automations/t-plus-onboarding/`** — the prior KAIA-734
   JSONs target the wrong stack (Supabase PostgREST). The replacement
   flows live in `automations/portal-internal-activity/`. The old
   folder should be deprecated and the four JSONs moved to an
   `archive/` subfolder so they don't get re-imported by mistake.
   **Canonical retirement path: [KAIA-761](/KAIA/issues/KAIA-761)
   (completed 2026-06-09).** The four JSONs now live in
   `automations/t-plus-onboarding/archive/`, the `README.md` and
   `DEPRECATED.md` at the folder root point here, and each JSON's
   `name` field is prefixed `[DEPRECATED — use portal-internal-activity]`
   so any accidental n8n import is visible in the workflow list.
   The original [KAIA-734](/KAIA/issues/KAIA-734) is now `cancelled`.
3. **Update `status-change-watcher.json`** — same migration to the
   portal endpoint (with `event_type` → `milestone='status_change'`
   and `day_offset` → `notes`). Track as a child issue.
4. **Smoke test against a live portal** — the current smoke is
   self-contained. Add a Playwright spec that exercises the route
   through the real Next.js dev server, using a fresh seed client
   and a temp `PORTAL_API_KEY`.

---

## 8. Reusability — next client

The four workflow exports are **client-agnostic** — they read the
`clientId` from the lookup-client response, not from hard-coded
values. The next Chatbot IA client takes ~5 minutes to onboard:

1. Import the four JSON files into n8n.
2. Create the `ChatbotClient` row (Backend's seed script handles dev).
3. Flip the schedule triggers from "off" to "active".
4. The portal's `/api/internal/activity` route handles the rest
   (idempotent upsert keyed on `(clientId, milestone)`).

No code changes. The template is what makes the 20% follow-up time
in the role guide possible.
