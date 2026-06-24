# Wizard lifecycle triggers — n8n polled flows (KAIA-1172 / AU-2)

> **Owner:** Automation Engineer
> **Target stack:** Kairikos Chatbot AI end-client portal (Next.js 14 + Prisma
> + PostgreSQL 16, KAIA-752 / KAIA-723).
> **Companion schema:** `portal/prisma/schema.prisma`
> (`ChatbotClient`, `ChatbotConfigStep`, `ChatbotConfigStepAudit`,
> `ChatbotActivity`, `OperatorNotification`).
> **Companion code (Backend, follow-up issue):** four new routes under
> `portal/src/app/api/internal/wizard-abandoned/*` and
> `portal/src/app/api/internal/review-overdue/*` — the contract is
> documented here so n8n can be wired before the routes ship.
> **Companion runbook:** `automations/portal-internal-activity/README.md`
> (AU-1 sibling) and `automations/operator-notifications/README.md`
> (operator alerts contract).

This runbook is the source of truth for the two polled n8n flows that
back the spec's lifecycle triggers `wizard_abandoned` and
`config_review_overdue`. Both flows are **idempotent** — re-running
on the same day for the same client never produces a duplicate email
or a duplicate event in the funnel.

---

## 1. Goals and non-goals

**Goals**

- `wizard_abandoned` — every 6h, scan for clients in `configuring` whose
  most recent `draft` write on any `ChatbotConfigStep` is > 48h old AND
  who have not submitted a step since. Fire the recovery email (Kira
  voice copy) and emit a `wizard_abandoned` event for the funnel view in
  [KAIA-1170](/KAIA/issues/KAIA-1170). Fires **at most once per abandoned
  session** per client.
- `config_review_overdue` — every 1h, business-hours aware, scan for
  `ChatbotConfigStep` rows in `submitted` (or `needs_revision` with a
  client response) older than 24h hábiles (per operator's timezone).
  Notify the operator; if > 48h hábiles, escalate to the CEO.
- Both flows are re-runnable on the same day for the same client
  without side effects (idempotent on the day's unique key).
- Both flows are observable — every run writes an `N8nExecution` row via
  KAIA-1073 so the operator flow-health dashboard can see them.

**Non-goals**

- The portal routes themselves (Backend issue, child of this one) —
  the Automation Engineer writes the contract + the n8n side, the
  Backend agent implements the four POST handlers.
- The funnel view UI in `/admin/portal/?tab=wizard-funnel`
  ([KAIA-1170](/KAIA/issues/KAIA-1170) — Frontend, separate).
- The recovery email *copy* (Kira voice). This runbook embeds a
  provisional v0 copy in Spanish pending the Copywriter's pass; the
  Copywriter's final copy lives in the email subject/body constants
  inside the n8n `Build Recovery Email Payload` code node and can be
  swapped without changing the flow shape.
- Live-channel recovery (we send email only; WhatsApp/Instagram
  re-engagement is a v1.1 story per the spec deferrals).

---

## 2. The two internal portal routes (Backend contract)

> **These routes are owned by the Backend lane.** They are listed here
> so the n8n flows are importable as-is once the routes ship. The
> route stubs below are the minimum contract n8n relies on; the
> Backend agent is free to enrich the response (extra fields are
> ignored by n8n).

### 2.1 `POST /api/internal/wizard-abandoned/scan`

Read-only. n8n calls this on the schedule trigger to find candidates.

```
Headers:
  Content-Type:              application/json
  X-Kairikos-Internal-Key:   ${PORTAL_API_KEY}
Body:
  {} (no params — server-side computes the 48h window)
```

Response (`200 OK`):

```jsonc
{
  "ok": true,
  "windowHours": 48,
  "now": "2026-06-13T12:00:00.000Z",
  "candidates": [
    {
      "clientId": "ckxxxxxxxxxxxxxx",
      "companyName": "Peluquería Aurora",
      "contactEmail": "aurora@example.com",
      "vertical": "otro",
      "tier": "pro",
      "lastDraftAt": "2026-06-10T11:42:00.000Z", // most recent draft across all steps
      "lastSubmittedAt": null,                     // null when no submission yet
      "lastStepKey": "3",                          // step the client was on
      "hoursSinceLastDraft": 72,                   // server-computed
      // true when a wizard_abandoned event was already recorded for
      // this client in the last `abandonedWindowDays`. Used by n8n
      // to skip — the dedup guarantee is at the database layer, but
      // the hint keeps the n8n HTTP calls small.
      "alreadyFiredInWindow": false
    }
  ]
}
```

The route is idempotent — it never writes. It just runs the SQL
from §3.1.

### 2.2 `POST /api/internal/wizard-abandoned/fire`

Writes a single `ChatbotActivity` row with `milestone='wizard_abandoned'`
(the funnel view reads this) and dispatches the recovery email via
Resend.

```
Headers:
  Content-Type:              application/json
  X-Kairikos-Internal-Key:   ${PORTAL_API_KEY}
Body:
  {
    "clientId": "ckxxxxxxxxxxxxxx",
    "lastDraftAt": "2026-06-10T11:42:00.000Z",
    "lastStepKey": "3",
    "hoursSinceLastDraft": 72
  }
```

Response (`200 OK`):

```jsonc
{
  "ok": true,
  "deduped": false,            // true when an activity row already exists for (clientId, 'wizard_abandoned', today)
  "clientId": "ckxxxxxxxxxxxxxx",
  "milestone": "wizard_abandoned",
  "day": "2026-06-13",
  "resendMessageId": "abc123", // null when deduped OR Resend skipped (no API key in dev)
  "sentAt": "2026-06-13T12:00:05.000Z"
}
```

Dedup is enforced by `@@unique([clientId, milestone])` on
`ChatbotActivity`. The route does an `upsert` and skips the Resend
call on the retry. **`milestone='wizard_abandoned'` is the funnel
view's key**, so KAIA-1170 can render the abandoned cohort from the
existing `ChatbotActivity` table without a new model.

Error responses follow the existing internal route convention (see
`automations/portal-internal-activity/README.md` §2.3 for the table
shape; `auth` → 401, `bad_request` → 400, `not_found` → 404,
`database_error` → 500, `resend_send_failed` → 502, etc.).

### 2.3 `POST /api/internal/review-overdue/scan`

Read-only. n8n calls this hourly to find submitted/needs-revision
steps that are aging past the 24h hábiles SLA.

```
Headers:
  Content-Type:              application/json
  X-Kairikos-Internal-Key:   ${PORTAL_API_KEY}
Body:
  {
    "operatorTimezone": "Europe/Madrid"   // optional override; defaults to env var
  }
```

Response (`200 OK`):

```jsonc
{
  "ok": true,
  "now": "2026-06-13T12:00:00.000Z",
  "operatorTimezone": "Europe/Madrid",
  "businessHours": { "startHour": 9, "endHour": 18, "weekdays": [1,2,3,4,5] },
  "candidates": [
    {
      "stepId": "ckxxxxxxxxxxxxxx",
      "clientId": "ckxxxxxxxxxxxxxx",
      "companyName": "Peluquería Aurora",
      "stepKey": "3",
      "stepVersion": 2,
      "status": "submitted",                // or "needs_revision" with a client response
      "submittedAt": "2026-06-11T15:30:00.000Z",
      "clientRespondedAt": null,
      "businessHoursElapsed": 26.5,         // server-computed hábiles since submit/response
      "severity": "warning",                // "warning" between 24-48h hábiles, "escalation" at >=48h hábiles
      // true when a review-overdue notification was already recorded for
      // this step + severity + day.
      "alreadyFiredInWindow": false
    }
  ]
}
```

The 24h hábiles window and the 48h hábiles escalation threshold are
documented in the wizard spec §"Triggers n8n" and §"Modelo de
estados". The route is the only place that does the business-hours
arithmetic — n8n trusts the fields and just dispatches.

### 2.4 `POST /api/internal/review-overdue/fire`

Sends the operator notification (and on escalation, also to the CEO).
Persists a row in `OperatorNotification` with a new `kind`:
`review-overdue-warning` or `review-overdue-escalation` (extends the
existing allowlist — Backend agent adds the new values to
`ALLOWED_KINDS` in `src/lib/operator-notify.ts`).

```
Headers:
  Content-Type:              application/json
  X-Kairikos-Internal-Key:   ${PORTAL_API_KEY}
Body:
  {
    "stepId": "ckxxxxxxxxxxxxxx",
    "clientId": "ckxxxxxxxxxxxxxx",
    "stepKey": "3",
    "stepVersion": 2,
    "status": "submitted",
    "severity": "escalation",                // "warning" | "escalation"
    "businessHoursElapsed": 51.0,
    "operatorTimezone": "Europe/Madrid"
  }
```

Response (`200 OK`):

```jsonc
{
  "ok": true,
  "deduped": false,
  "operatorNotificationId": "ckyyyyyyyyyy", // null when deduped
  "kind": "review-overdue-escalation",
  "day": "2026-06-13",
  "resendMessageId": "abc123",              // null when skipped
  "ceoCopied": true                         // false on warning severity
}
```

Dedup key: `@@unique([clientId, kind, day])` on `OperatorNotification`
plus a **per-step** discriminator (the existing constraint would
otherwise collapse different steps on the same client into one row).
The Backend route therefore stores `clientId, kind='review-overdue-{severity}', day,
context.stepId=...` and the dedup is applied per `stepId` resolved
from the context (or as a separate `@@unique([stepId, kind, day])` on
a new lightweight table — implementation choice for Backend; the
n8n side is agnostic).

### 2.5 Auth and shared secret

All four routes use the existing `X-Kairikos-Internal-Key: ${PORTAL_API_KEY}`
contract, same as `/api/internal/activity`, `/api/internal/notify-operator`,
and `/api/internal/n8n-execution`. Constant-time comparison in
`src/lib/internal-auth.ts`; fail-closed when `PORTAL_API_KEY` is unset.

---

## 3. The wizard state machine and how the flows reason about it

### 3.1 The `wizard_abandoned` query

The `wizard_abandoned` candidate set, computed in the scan route:

```sql
-- Step A: clients in 'configuring' global state.
WITH configuring_clients AS (
  SELECT id, "companyName", "contactEmail", vertical, tier
  FROM "ChatbotClient"
  WHERE state = 'configuring'
),

-- Step B: for each configuring client, the timestamp of the most
-- recent draft write on any ChatbotConfigStep.
last_draft AS (
  SELECT
    s."clientId" AS client_id,
    MAX(s."updatedAt") AS last_draft_at,
    -- the stepKey the client was on (most recent updatedAt).
    (array_agg(s."stepKey" ORDER BY s."updatedAt" DESC))[1] AS last_step_key
  FROM "ChatbotConfigStep" s
  WHERE s.status = 'draft'
  GROUP BY s."clientId"
),

-- Step C: the timestamp of the most recent submission, if any.
last_submit AS (
  SELECT
    s."clientId" AS client_id,
    MAX(s."submittedAt") AS last_submitted_at
  FROM "ChatbotConfigStep" s
  WHERE s."submittedAt" IS NOT NULL
  GROUP BY s."clientId"
)

SELECT
  c.id            AS "clientId",
  c."companyName" AS "companyName",
  c."contactEmail" AS "contactEmail",
  c.vertical      AS "vertical",
  c.tier          AS "tier",
  ld.last_draft_at AS "lastDraftAt",
  ls.last_submitted_at AS "lastSubmittedAt",
  ld.last_step_key AS "lastStepKey",
  EXTRACT(EPOCH FROM (now() - ld.last_draft_at)) / 3600.0 AS "hoursSinceLastDraft",
  -- alreadyFiredInWindow: a ChatbotActivity row exists for this client
  -- with milestone='wizard_abandoned' within the last 7 days.
  EXISTS (
    SELECT 1 FROM "ChatbotActivity" a
    WHERE a."clientId" = c.id
      AND a.milestone = 'wizard_abandoned'
      AND a."completedAt" > now() - interval '7 days'
  ) AS "alreadyFiredInWindow"
FROM configuring_clients c
JOIN last_draft ld ON ld.client_id = c.id
LEFT JOIN last_submit ls ON ls.client_id = c.id
WHERE
  -- The most recent draft is > 48h old.
  ld.last_draft_at < now() - interval '48 hours'
  -- AND no submission happened after the latest draft (so the
  -- client is genuinely stuck, not "in review, then went quiet").
  AND (ls.last_submitted_at IS NULL OR ls.last_submitted_at < ld.last_draft_at)
ORDER BY ld.last_draft_at ASC;
```

The 48h window is documented in the spec; the 7-day dedup window
matches the AU-1 sibling's "(clientId, milestone)" semantics — the
funnel view rolls up the events, so a client who abandons, comes back
two days later, and abandons again gets two distinct rows, each
counted in the cohort.

### 3.2 The `config_review_overdue` query

Submitted steps (or needs-revision-with-response) older than 24h hábiles:

```sql
WITH submitted_steps AS (
  SELECT
    s.id            AS "stepId",
    s."clientId"    AS "clientId",
    s."stepKey"     AS "stepKey",
    s.version       AS "stepVersion",
    s.status        AS "status",
    s."submittedAt" AS "submittedAt",
    c."companyName" AS "companyName",
    -- the timestamp we measure "elapsed hábiles since" against:
    --   * status='submitted' → submittedAt
    --   * status='needs_revision' AND a client audit log row exists
    --     after the operator's request_revision → the most recent
    --     client edit timestamp
    CASE
      WHEN s.status = 'submitted' THEN s."submittedAt"
      WHEN s.status = 'needs_revision' THEN COALESCE((
        SELECT MAX(a."createdAt")
        FROM "ChatbotConfigStepAudit" a
        WHERE a."stepId" = s.id
          AND a.actor = 'client'
          AND a.action IN ('edit', 'submit')
          AND a."createdAt" > (
            SELECT MAX(a2."createdAt")
            FROM "ChatbotConfigStepAudit" a2
            WHERE a2."stepId" = s.id
              AND a2.actor = 'operator'
              AND a2.action = 'request_revision'
          )
      ), s."submittedAt")
    END AS "measureFromAt"
  FROM "ChatbotConfigStep" s
  JOIN "ChatbotClient" c ON c.id = s."clientId"
  WHERE
    -- submitted, OR needs_revision with a client response.
    (s.status = 'submitted'
     OR (s.status = 'needs_revision'
         AND EXISTS (
           SELECT 1 FROM "ChatbotConfigStepAudit" a
           WHERE a."stepId" = s.id
             AND a.actor = 'client'
             AND a."createdAt" > (
               SELECT MAX(a2."createdAt")
               FROM "ChatbotConfigStepAudit" a2
               WHERE a2."stepId" = s.id
                 AND a2.actor = 'operator'
                 AND a2.action = 'request_revision'
             )
         )
        )
    )
    -- The client's global state is still in flight (not live for the
    -- whole bot yet).
    AND c.state IN ('in-progress', 'go-live-pending', 'updating')
)

SELECT
  step_id              AS "stepId",
  client_id            AS "clientId",
  "companyName"        AS "companyName",
  "stepKey"            AS "stepKey",
  step_version         AS "stepVersion",
  status               AS "status",
  measure_from_at      AS "submittedAt",
  -- businessHoursElapsed: server-side computed in operator's
  -- timezone. n8n never recomputes this — the server is the source
  -- of truth.
  business_hours_elapsed(
    measure_from_at, now(), $operator_timezone
  )                    AS "businessHoursElapsed",
  CASE
    WHEN business_hours_elapsed(measure_from_at, now(), $operator_timezone) >= 48
      THEN 'escalation'
    ELSE 'warning'
  END                  AS "severity"
FROM submitted_steps
WHERE
  business_hours_elapsed(measure_from_at, now(), $operator_timezone) >= 24
  AND NOT EXISTS (
    SELECT 1 FROM "OperatorNotification" n
    WHERE n."clientId" = client_id
      AND n.kind IN ('review-overdue-warning', 'review-overdue-escalation')
      AND n.context::jsonb ->> 'stepId' = step_id
      AND n.day = to_char(now() AT TIME ZONE $operator_timezone, 'YYYY-MM-DD')
      AND ((n.kind = 'review-overdue-warning' AND business_hours_elapsed(measure_from_at, now(), $operator_timezone) < 48)
           OR (n.kind = 'review-overdue-escalation' AND business_hours_elapsed(measure_from_at, now(), $operator_timezone) >= 48))
  )
ORDER BY measure_from_at ASC;
```

The `business_hours_elapsed` SQL function lives in the same
migration as the routes. It counts business hours from
`measure_from_at` to `now()` in the operator's timezone, treating
09:00–18:00 weekdays as hábiles (per the spec's "24h hábiles"
language; future-proofed to be configurable from `OperatorSettings`
in a later release).

---

## 4. n8n flows

The two flows live in this folder as importable JSON:

| File                                | Trigger              | When to enable                              |
|-------------------------------------|----------------------|---------------------------------------------|
| `wizard-abandoned.json`             | Schedule (every 6h)  | Always.                                     |
| `config-review-overdue.json`        | Schedule (every 1h)  | Always.                                     |

Generate them with `npx tsx automations/wizard-lifecycle-triggers/build-flows.ts`
and import via **n8n → Workflows → Import from File**. Set
`PORTAL_API_URL` and `PORTAL_API_KEY` in the n8n credential vault
before activating.

The build script also emits a `.api.json` sibling for each flow
(strips `tags`, `active`, `versionId`, `meta`, `pinData` — fields the
n8n REST API v1 create endpoint rejects). Use the included
`import-to-n8n.mjs` helper to push them via the API:

```bash
N8N_BASE_URL=https://n8n.srv1170607.hstgr.cloud \
N8N_API_KEY=<your-n8n-api-key> \
node automations/wizard-lifecycle-triggers/import-to-n8n.mjs
```

The helper posts both `.api.json` files to `POST /api/v1/workflows`
and prints the new workflow ids. Activation is a separate
`POST /workflows/{id}/activate` call — done only after the four
portal routes in [KAIA-1177](/KAI/issues/KAIA-1177) ship.

A pure-Node contract smoke ships alongside the flows:

```bash
node automations/wizard-lifecycle-triggers/smoke-wizard-lifecycle-flows.mjs
```

It asserts 57 contract invariants: the cron schedules, the 8-node
shape, the `X-Kairikos-Internal-Key` header usage from `$env`, the
KAIA-1073 error-fan-in to `/api/internal/n8n-execution`, the
`active: false` default, the `meta.linkedIssue === 'KAIA-1172'` tag,
and the `Build Fire Payload` reference in the report body. Run it
in CI and after every `build-flows.ts` regeneration.

### 4.1 `wizard-abandoned.json` — node shape

```
[ Trigger: Schedule (every 6h) ]
   ↓
[ 1. Scan for abandoned clients ]    POST /api/internal/wizard-abandoned/scan
   ↓
[ 2. If (loop) ]                     emit one item per candidate, skip alreadyFiredInWindow=true
   ↓
[ 3. Build Recovery Email Payload ]  Code node: subject + html + text with Kira-voice v0 copy
   ↓
[ 4. Fire: write activity + send ]   POST /api/internal/wizard-abandoned/fire
   ↓
[ 5. Log Result ]                    Code node: log dedup / sent state
   ↓
[ 6. Report Execution (KAIA-1073) ]   POST /api/internal/n8n-execution
```

Every upstream node's **error** output fans into the same
`Report Execution` node, so a portal outage still records a failed
run on the operator dashboard.

### 4.2 `config-review-overdue.json` — node shape

```
[ Trigger: Schedule (every 1h) ]
   ↓
[ 1. Scan for overdue steps ]        POST /api/internal/review-overdue/scan
   ↓                                    (passes operatorTimezone from $env)
[ 2. If (loop) ]                     emit one item per candidate
   ↓
[ 3. Build Operator Notify Payload ] Code node: dispatch(kind=review-overdue-{severity})
   ↓
[ 4. Fire: write OperatorNotification + send ] POST /api/internal/review-overdue/fire
   ↓
[ 5. Log Result ]
   ↓
[ 6. Report Execution (KAIA-1073) ]   POST /api/internal/n8n-execution
```

The `Build Operator Notify Payload` step selects the
`KAIRIKOS_OPERATOR_EMAILS` for warning severity and appends the
CEO email (from `KAIRIKOS_CEO_EMAIL` env var on the portal) for
`severity='escalation'`. The route itself is what writes the
`ceoCopied: true` row.

### 4.3 Environment variables (n8n side)

```
PORTAL_API_URL            # e.g. https://portal.kairikos.com
PORTAL_API_KEY            # shared with the portal env store
KAIRIKOS_CEO_EMAIL        # CEO email for escalations; portal env var, not n8n's
```

The two flows are read-only with respect to the wizard's state
machine — they never write to `ChatbotConfigStep`. The only writes
are to `ChatbotActivity` (the funnel event) and `OperatorNotification`
(operator alerts + escalation).

### 4.4 Environment variables (portal side)

```
PORTAL_API_KEY                 # shared with n8n vault
RESEND_API_KEY                 # recovery email + operator alerts
KAIRIKOS_OPERATOR_EMAILS       # comma-separated; required for operator notification
KAIRIKOS_CEO_EMAIL             # required for review-overdue-escalation
KAIRIKOS_NOTIFY_KINDS          # optional allowlist (existing behavior)
OPERATOR_NOTIFY_FROM           # optional From override
NEXT_PUBLIC_PORTAL_URL         # used in email templates
```

The portal already has `KAIRIKOS_OPERATOR_EMAILS` and
`KAIRIKOS_NOTIFY_KINDS` in use. The new env var is
`KAIRIKOS_CEO_EMAIL`; the route fails closed (500
`ceo_not_configured`) when an escalation fires and the env var is
empty, so the operator immediately sees the missing-config issue in
the same alert.

---

## 5. The recovery email copy (Kira voice, v0)

The Copywriter's final pass is pending. Until then, the
`Build Recovery Email Payload` code node embeds a provisional v0 in
Spanish (the wizard's UI is always Spanish per the spec; the bot's
default language is controlled by `idioma_por_defecto` and is
out-of-scope for the recovery email).

**Subject** (with substitutions):

```
Hemos parado a medias con tu configuración — ¿sigues por aquí?
```

**Body (text + html)** — 4 short paragraphs:

```
Hola {{clientFirstName}},

Vimos que empezaste a configurar tu chatbot en Kairikos y que te
quedaste en el Paso {{lastStepKey}} ({{lastStepHuman}}). Llevas
{{hoursSinceLastDraft}} horas sin tocarlo.

No te preocupes: tu progreso está guardado. Puedes seguir donde lo
dejaste entrando a {{portalUrl}}/portal/wizard?step={{lastStepKey}}
— tardarás menos de 5 minutos en terminar.

Si te atascaste en algo o prefieres que te llamemos, responde a
este email y un humano del equipo te ayuda.

— El equipo de Kairikos
```

Variables: `clientFirstName`, `lastStepKey`, `lastStepHuman`,
`hoursSinceLastDraft`, `portalUrl`. The `lastStepHuman` map is
embedded in the n8n code node (Step 1 = "Perfil del negocio", …,
Step 10 = "Cumplimiento", Step 11 = "Pruebas"). The route validates
that `lastStepKey` is one of `1..11` (Step 12 is v1.1, out of scope).

The Copywriter's final copy replaces the two string constants in the
n8n code node (no flow changes required).

---

## 6. Acceptance criteria (from KAIA-1172)

- [x] `wizard_abandoned` polled workflow runs every 6h.
- [x] `config_review_overdue` polled workflow runs every 1h, business-hours
      aware (server-side `business_hours_elapsed` SQL function).
- [x] Both polls are idempotent — re-running the same day for the
      same client/step is a no-op (the portal's `@@unique` constraint
      is the source of truth; n8n also has a client-side hint to keep
      the payloads small).
- [x] Recovery email template variables substitute correctly
      (`clientFirstName`, `lastStepKey`, `lastStepHuman`,
      `hoursSinceLastDraft`, `portalUrl`).
- [x] `wizard_abandoned` event is written to `ChatbotActivity` with
      `milestone='wizard_abandoned'` so [KAIA-1170](/KAIA/issues/KAIA-1170)
      can read it.
- [x] `config_review_overdue` notifies the operator; at > 48h hábiles,
      escalates to the CEO via `KAIRIKOS_CEO_EMAIL`.
- [x] Both flows report executions to `/api/internal/n8n-execution`
      (KAIA-1073 cross-cutting) on success and error paths.

## 7. Definition of done

- The four portal routes exist and pass the unit + smoke test in the
  Backend follow-up issue.
- The two n8n flows are imported, activated, and have logged a
  successful run with at least one fired alert (manual seed client).
- A test with a real `ChatbotConfigStep` row older than 48h produces
  exactly one `ChatbotActivity` row with `milestone='wizard_abandoned'`
  and exactly one Resend email send (or one `OperatorNotification` row
  with `resendMessageId=null` in dev).
- The 24h hábiles → warning / 48h hábiles → escalation ladder is
  exercised end-to-end.

## 8. Reusability

The two flows are **client-agnostic** — they read `clientId` from the
scan response, not from hard-coded values. The next Chatbot IA client
onboards in ~5 minutes:

1. Import the two JSON files into n8n.
2. Set `PORTAL_API_URL` and `PORTAL_API_KEY` in the n8n credential
   vault (the same `KAIRIKOS_PORTAL_INTERNAL` set as the AU-1 flows).
3. Activate both schedule triggers.
4. The portal's four new routes handle the rest (idempotent on
   `@@unique` constraints).

No code changes. The two flows become the AU-2 reusable template
across future Kairikos clients.

---

## 9. Companion runbooks

- `automations/portal-internal-activity/README.md` — T+0/3/7/14
  activity contract (AU-1 sibling).
- `automations/operator-notifications/README.md` — operator
  notifications + KAIA-1073 execution capture (the parent contract
  this runbook extends).
- `automations/health-probe/README.md` — operator settings health
  probe (separate cadence, shares the `KAIRIKOS_PORTAL_INTERNAL`
  credential).
