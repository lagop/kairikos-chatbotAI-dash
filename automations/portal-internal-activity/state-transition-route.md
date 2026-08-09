# State-transition route — POST /api/internal/clients/[id]/state-transition

> **Owner:** CTO
> **Issue:** [KAIA-3129](/KAIA/issues/KAIA-3129)
> **Companion code:** `portal/src/app/api/internal/clients/[id]/state-transition/route.ts`,
> `portal/src/lib/activity-key-auth.ts`,
> `portal/scripts/smoke-internal-state-transition.ts`,
> `portal/prisma/schema.prisma` (`ChatbotClient.state`, `ChatbotActivity`).
> **Required env (operator):** `KAIRIKOS_INTERNAL_ACTIVITY_KEY` in Vercel
> project env ([KAIA-3126](/KAIA/issues/KAIA-3126)).

A reusable header-gated internal surface for the Automation Engineer
(AE) to flip `ChatbotClient.state` between onboarding milestones
without going through the operator-facing admin UI (which needs a
session-authenticated operator) or the self-service go-live button
(only flips one way, only when the client clicks it).

The route is intentionally small, opinionated, and idempotent. The
goal is to unblock every future Day-2 client (Starter tier is the
bulk of Kairikos volume) without writing a new route per client.

---

## 1. Goals and non-goals

**Goals**

- One endpoint to flip `ChatbotClient.state` from any source the AE
  can call from n8n, the operator console, or a curl invocation.
- Strict allowlist of values: `in-progress`, `go-live-pending`,
  `live`, `paused`, `archived`, `draft`. Any other value is rejected
  with `400 bad_request`.
- A separate, low-blast-radius shared secret
  (`KAIRIKOS_INTERNAL_ACTIVITY_KEY`) for the AE trust boundary —
  distinct from `PORTAL_API_KEY` (the n8n → portal activity/lookup
  trust boundary). Leak of one must not give write access to the
  other. Blast-radius lens.
- Idempotent at every level: re-applying the same state is a no-op,
  and the activity log is upserted (not inserted) so the
  `@@unique([clientId, milestone])` constraint is preserved.
- An audit trail on `ChatbotActivity` with `milestone='status_change'`
  and a JSON `notes` payload carrying `previous_state`, `new_state`,
  `actor`, `reason`.

**Non-goals**

- State-machine validation (e.g. refusing to go from `archived` back
  to `live`). v1 accepts any allowlisted source → any allowlisted
  target. The AE / operator is responsible for the legal transitions.
  Add explicit transition validation in v2 if Day-2 audit shows
  accidental misuse.
- Multi-tenant scoping beyond the per-`clientId` URL parameter. The
  trust boundary is the header secret; whoever holds it can flip any
  client. Keep the secret in Vercel project env + the AE's credential
  vault, never on a per-agent `adapterConfig.env`.
- Reading the client state back. Use the existing
  `/api/admin/portal/clients/[id]/flow` GET (session-auth, operator)
  or a Prisma query for non-UI consumers.

---

## 2. Endpoint contract

```
POST  {PORTAL_API_URL}/api/internal/clients/{clientId}/state-transition
Headers:
  Content-Type:             application/json
  X-Internal-Activity-Key:  ${KAIRIKOS_INTERNAL_ACTIVITY_KEY}
Body:
  {
    "state":  "<one of in-progress, go-live-pending, live, paused, archived, draft>",
    "reason": "<optional free-form string ≤ 2000 chars; recorded in the activity log>"
  }
```

### 2.1 Success response — 200

```json
{
  "ok": true,
  "noop": false,
  "clientId": "<cuid>",
  "previousState": "in-progress",
  "state": "go-live-pending",
  "goLiveAt": null,
  "updatedAt": "<ISO-8601>"
}
```

`noop: true` is returned when the row is already at the requested
state. No DB write occurs, no activity row is touched.

`goLiveAt` is set to the current timestamp **only** on the transition
to `live` where the previous state was not `live`. It is preserved
on subsequent transitions (paused → live re-emits a fresh `goLiveAt`
because the implementation keys on `previousState !== 'live'`; if
that semantics changes, document here).

### 2.2 Error responses

| Status | `error`                  | `detail`              | When                                                                  |
|--------|--------------------------|-----------------------|-----------------------------------------------------------------------|
| 400    | `bad_request`            | (route-defined)       | Body is not JSON, or `state` is missing / not in the allowlist.       |
| 401    | `missing_or_invalid_key` | (omitted on purpose)  | `X-Internal-Activity-Key` missing or does not match the env var.      |
| 404    | `not_found`              | `clientId does not exist` | URL `clientId` does not match a `ChatbotClient` row.               |
| 500    | `server_misconfigured`   | (omitted)             | `KAIRIKOS_INTERNAL_ACTIVITY_KEY` is unset in Vercel project env.      |
| 500    | `database_error`         | `prisma.<code>`       | Prisma error during the transaction.                                  |
| 503    | `database_not_configured` | `DATABASE_URL is not set; refusing to write` | `DATABASE_URL` is unset.                  |

`401` deliberately does not distinguish missing-header from bad-value
to avoid probing the header name vs the value path.

### 2.3 Activity log shape

A successful transition writes one `ChatbotActivity` row (upsert,
keyed on `clientId` + `milestone='status_change'`):

```
ChatbotActivity {
  clientId:    <cuid>,
  milestone:   "status_change",
  completedAt: <now>,
  notes:       JSON.stringify({
    previous_state: "in-progress",
    new_state:      "go-live-pending",
    actor:          "internal_activity_key",
    reason:         "<reason|null>"
  })
}
```

This mirrors the existing `/api/internal/activity` shape for the
`status_change` milestone (KAIA-760 / KAIA-2969). The portal's
operator-facing flow timeline (`/api/admin/portal/clients/[id]/flow`)
already reads these rows, so the AE's state-flip is visible in the
operator UI immediately.

> **Spec drift note.** The KAIA-3129 issue description referred to a
> `type='state_transition'` column. The Prisma schema has no such
> column — the existing model uses `milestone` with
> `status_change` as a documented value (KAIA-760). The
> implementation lands on `milestone='status_change'` with the
> structured JSON `notes` payload. Same data on the same row; the
> portal's existing reader already understands it. If the schema
> evolves to add a `type` column, update this route to write the
> `type` field at the same time as `milestone` (see `Follow-ups`).

---

## 3. Auth (deliberately separate from PORTAL_API_KEY)

```
X-Internal-Activity-Key:  <32-64 char random secret>
```

The shared secret lives in:

- **Server side:** Vercel project env
  `KAIRIKOS_INTERNAL_ACTIVITY_KEY` (operator provisions per
  [KAIA-3126](/KAIA/issues/KAIA-3126)).
- **Client side:** AE credential vault (1Password / n8n credential /
  whatever the AE uses for non-Vercel secrets).

The portal compares the header value with
`crypto.timingSafeEqual`. Length-mismatched inputs still pay the
constant-time cost so the response time does not leak the secret
length. See `src/lib/activity-key-auth.ts` for the implementation.

The auth helper is **deliberately separate** from `src/lib/internal-auth.ts`
(which uses `PORTAL_API_KEY` for the n8n → portal T+0/3/7/14 +
lookup-client surfaces). Two trust boundaries, two secrets. A leak
of `PORTAL_API_KEY` must not give an attacker the ability to flip
`ChatbotClient.state`, and a leak of
`KAIRIKOS_INTERNAL_ACTIVITY_KEY` must not give an attacker write
access to the n8n milestone feeds.

### 3.1 Generating the secret

```bash
openssl rand -hex 32   # 64 hex chars; one strong option
```

Treat as low-blast-radius — it gates a single internal route that
only writes to `ChatbotClient.state` — but **never paste the value
in any Paperclip comment, chat, screenshot, or commit**. The
delivery channel is the operator's Vercel CLI / dashboard + the
AE's credential vault.

### 3.2 Provisioning checklist (operator)

```
vercel env add KAIRIKOS_INTERNAL_ACTIVITY_KEY production
  # paste the value when prompted; Vercel stores it in the project-scoped env.

vercel env add KAIRIKOS_INTERNAL_ACTIVITY_KEY preview
  # same value, so preview deploys can also be smoke-tested.

vercel deploy --prod   # only if a redeploy is needed (the env var
                       # change does not retroactively deploy per
                       # the KAIA-2809 / KAIA-2330 rule)
```

---

## 4. Curl invocation for the AE

```bash
PORTAL_API_URL="https://portal.kairikos.com"   # or project-fxidg.vercel.app
CLIENT_ID="<ChatbotClient.id from the client row>"
KEY="$(op read 'op://Kairikos/kairikos-secrets/kairikos-internal-activity-key')"

curl -sS -X POST "$PORTAL_API_URL/api/internal/clients/$CLIENT_ID/state-transition" \
  -H "Content-Type: application/json" \
  -H "X-Internal-Activity-Key: $KEY" \
  -d '{"state":"go-live-pending","reason":"T+14 review passed, ready for QA"}'
```

For the Day-2 smoke 28 client referenced in [KAIA-3125](/KAIA/issues/KAIA-3125)
(the live AE handoff), the AE reads `clientId` from the
IntakeSubmission / ChatbotClient row in the operator console; the
curl invocation is otherwise identical.

---

## 5. Smoke test

Self-contained — does not need a live HTTP server, does not need
docker / postgres. Runs in CI:

```
npm run smoke:internal-state-transition
```

Asserts **45 cases**:

- Auth (5): matching key, wrong key, missing header, server
  misconfigured, length mismatch.
- Body validation (11): valid state, missing state, non-string state,
  null state, empty string, unknown value (rejected), reason
  truncation to 2000 chars, body not an object, body is null,
  reason is not a string.
- Allowlist coverage (6): every value listed in the issue spec is
  accepted.
- Idempotency (3): re-applying the same state returns `noop: true`,
  writes no second activity row, leaves `goLiveAt` unchanged.
- Successful transition (18): flips state, writes activity row,
  sets `goLiveAt` on the in-progress → live edge, preserves
  `goLiveAt` across paused round-trips, refreshes `goLiveAt` on
  the paused → live edge, preserves the activity row id across
  the upsert.
- Failure modes (1): unknown `clientId` raises `client_not_found`
  (the route maps this to `404 not_found`).

---

## 6. Deploy evidence (per [KAIA-2809](/KAIA/issues/KAIA-2809))

| What                          | Value                                                                                |
|-------------------------------|--------------------------------------------------------------------------------------|
| Merge commit on `main`        | `22c6b015a30a5420a1c1e84815fb49ee5777a02b` (short: `22c6b01`)                        |
| Vercel Production deployment  | GitHub deployment `5464846501` for `sha 22c6b01`, `environment: "Production"`        |
| Live route URL                | `https://project-fxidg.vercel.app/api/internal/clients/{clientId}/state-transition` |
| Live route probe (no header)  | HTTP 500 `{"error":"server_misconfigured"}` (correct — env var not yet provisioned)  |
| Live route probe (wrong hdr)  | HTTP 500 `{"error":"server_misconfigured"}` (correct — same env-var-not-set path)    |
| Expected after KAIA-3126 done | HTTP 401 `{"error":"missing_or_invalid_key"}` for missing/wrong header              |
|                              | HTTP 404 `{"error":"not_found"}` for unknown clientId                                |
|                              | HTTP 200 with the documented success body for valid calls                            |

Once [KAIA-3126](/KAIA/issues/KAIA-3126) (operator provisions the
env var in Vercel) closes, the AE runs the curl in §4 against
`portal-fxidg.vercel.app` (or `portal.kairikos.com` once the custom
domain is re-pointed) and asserts the documented 4xx/200 responses.

---

## 7. Reusability — next Day-2 client

When the next client reaches T+14 and is ready for go-live:

1. **No code change.** The route, smoke, and contract are already
   shipped.
2. **No new env var.** The operator does not need to provision a new
   `KAIRIKOS_INTERNAL_ACTIVITY_KEY` per client — the existing
   project-wide value is used.
3. **AE fires the curl.** Against the client ID resolved from the
   intake payload (same lookup-client path as the T+N flows). Body:
   `{ "state": "go-live-pending", "reason": "T+14 review passed" }`.
4. **Operator reviews the QA queue.** The operator UI
   (`/admin/portal/[clientId]`) already shows the new
   `status_change` activity row.
5. **Operator approves.** The operator flips the client to `live`
   via the existing admin UI (session-auth). The `live` transition
   sets `goLiveAt` on the client row.

If a client is paused mid-onboarding, the AE reuses the same route
to flip to `paused` (or to resume later). Archived clients are
reactivated through the same route.

The 10-minute "next operator" promise from the issue spec comes from
this pattern being reusable without per-client configuration.

---

## 8. Follow-ups

1. **Spec drift** — track in a child issue whether the schema should
   gain a `type` column on `ChatbotActivity` so the route can write
   `type='state_transition'` directly (per the literal issue
   description). Today the route uses `milestone='status_change'` to
   stay within the existing schema. The structured `notes` JSON
   carries the same data, so this is documentation-level, not
   behavioral.
2. **State-machine validation (v2)** — when audit logs show accidental
   misuse, add explicit transition rules in the route (e.g. refuse
   `archived` → `live`). Today v1 accepts any allowlisted source →
   any allowlisted target.
3. **Replay safety on `goLiveAt`** — the current implementation
   refreshes `goLiveAt` whenever `previousState !== 'live'`, including
   the `paused → live` re-go-live edge. If product semantics require
   preserving the **first** `goLiveAt` across pause cycles, change
   the predicate to `previousState === 'in-progress' || previousState
   === 'go-live-pending'` so only the first-time go-live sets the
   timestamp. Document the chosen semantics here.
4. **Smoke against a live portal** — the current smoke is
   self-contained. Add a Playwright spec that exercises the route
   through the real Next.js dev server using a fresh seed client and
   a temp `KAIRIKOS_INTERNAL_ACTIVITY_KEY`, mirroring the QA plan
   in §6 of the parent runbook.
