# Per-integration health probes — reusable template (KAIA-1110)

> **Owner:** Automation Engineer
> **Origin:** Kairikos Chatbot AI end-client portal — operator
> observability play (KAIA-1058 / Option B).
> **Companion code:**
> `portal/src/lib/health-probe.ts`, `portal/src/lib/operator-settings.ts`,
> `portal/scripts/health-probe.ts`, `portal/src/app/api/internal/health-probe/{run,ping}/route.ts`,
> `portal/prisma/schema.prisma` (`OperatorSettings` + `OperatorSettingsAudit`).

This template packages a small, reusable observability system: a worker
that polls every external integration on a 5-minute cadence and surfaces
the result in the operator portal as a `healthy` / `degraded` / `failed`
/ `unknown` status pill. Drop it into any Kairikos client portal that
already has the `OperatorSettings` + `OperatorSettingsAudit` Prisma
models, set four env vars, and the operator gets an at-a-glance view of
which integrations are sideways — without opening each vendor's dashboard
individually.

---

## 1. What you get

- A **TypeScript probe library** (`src/lib/health-probe.ts`) with one
  pluggable probe per `toolKey`: `resend`, `n8n`, `supabase`,
  `portal_api_key`. Unknown `toolKey`s fall through to a no-op
  `unknown` status.
- A **long-running worker** (`scripts/health-probe.ts`) that runs an
  immediate pass on startup, then every 5 minutes thereafter. Each
  probe is wrapped in a 5 s timeout; concurrency is capped at 4
  (configurable). The worker is safe to restart at any cadence — see
  "Idempotency" below.
- A **GET endpoint** (`/api/internal/health-probe/run`) that triggers an
  immediate run and returns the per-`toolKey` results in JSON. Used by
  the QA smoke and by the future "check now" button on the settings
  page.
- A **GET endpoint** (`/api/internal/health-probe/ping`) used by the
  `portal_api_key` probe to confirm the key still authenticates. No DB
  access, no side effects.
- A **state-change audit trail**: every healthy → failed (or any
  cross-state) transition writes an `OperatorSettingsAudit` row with
  `action: 'health_status_changed'`, so the operator can scroll the
  audit log and see when an integration went sideways.

---

## 2. Reuse checklist (next Kairikos client)

1. Apply the `OperatorSettings` + `OperatorSettingsAudit` Prisma
   migration (see `portal/prisma/schema.prisma` for the canonical
   schema).
2. Copy the four files:
   - `portal/src/lib/health-probe.ts`
   - `portal/scripts/health-probe.ts`
   - `portal/src/app/api/internal/health-probe/run/route.ts`
   - `portal/src/app/api/internal/health-probe/ping/route.ts`
3. Add the worker to your `docker-compose.yml` (or systemd unit) as
   a separate service. See the "docker-compose snippet" section below.
4. Add the four env vars (see section 4).
5. Run the smoke (section 5) once to confirm the four probes return
   the correct status against the live integrations.
6. Add the "last health check" column + status pill to the settings
   page (one read on `OperatorSettings.lastHealthCheckAt` and
   `lastHealthStatus` per row). The probe writes them; the page just
   renders.

---

## 3. Idempotency and error handling

- **Idempotency**: the probe is read-only against every external
  service. The only writer to `OperatorSettings.lastHealthStatus` and
  `lastHealthCheckAt` is `recordHealthCheck()` in
  `src/lib/operator-settings.ts`, which only writes an
  `OperatorSettingsAudit` row when the new status differs from the
  previous one. Repeated calls within a stable state are a no-op at
  the audit level.
- **Error handling**: every probe is wrapped in a try/catch that
  converts the exception into a `failed` or `degraded` outcome. A
  probe that throws (network down, DNS failure, 5xx) is still recorded
  — silently failing is not an option (per the Automation Engineer
  output bar).
- **Per-probe timeout**: 5 s, enforced via `AbortController`. A probe
  that exceeds the timeout is recorded as `degraded`, not `failed` —
  the integration may be slow but reachable, and `degraded` is the
  honest status.
- **Concurrency cap**: 4 simultaneous probes. The probe library is
  promise-based; the worker uses a small pool to avoid hammering
  vendor APIs if the settings table grows past a few dozen rows.
- **Worker resilience**: if a pass throws (e.g. Prisma hiccup), the
  worker logs and retries on the next interval. The worker does not
  exit on transient errors.

---

## 4. Environment

| Var | Required | Default | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | — | Prisma connection string. Same as the rest of the portal. |
| `RESEND_API_KEY` | for `resend` probe | — | The Resend API key the operator has stored in 1Password. |
| `N8N_API_KEY` | for `n8n` probe | — | The n8n API key. |
| `N8N_BASE_URL` | optional | `https://n8n.kairikos.com` | Override if the client has their own n8n. |
| `PORTAL_API_KEY` | for `portal_api_key` probe | — | The shared secret the portal uses for `/api/internal/*`. |
| `NEXT_PUBLIC_PORTAL_URL` | for `portal_api_key` probe | — | The public URL the probe calls to test the key. |
| `HEALTH_PROBE_INTERVAL_MS` | optional | `300000` (5 min) | Polling cadence. |
| `HEALTH_PROBE_TIMEOUT_MS` | optional | `5000` | Per-probe timeout. |
| `HEALTH_PROBE_CONCURRENCY` | optional | `4` | Max parallel probes. |

All secrets must be sourced from the platform's secret store (1Password
or equivalent). The worker never logs secret values — only lengths and
error codes.

---

## 5. docker-compose snippet

```yaml
  health-probe:
    image: ghcr.io/<your-org>/<your-portal>-app:latest
    container_name: <your-portal>-health-probe
    restart: unless-stopped
    command: ["npx", "tsx", "scripts/health-probe.ts"]
    environment:
      NODE_ENV: production
      DATABASE_URL: ${DATABASE_URL}
      RESEND_API_KEY: ${RESEND_API_KEY}
      N8N_API_KEY: ${N8N_API_KEY}
      N8N_BASE_URL: ${N8N_BASE_URL:-https://n8n.example.com}
      PORTAL_API_KEY: ${PORTAL_API_KEY}
      NEXT_PUBLIC_PORTAL_URL: ${NEXT_PUBLIC_PORTAL_URL}
      HEALTH_PROBE_INTERVAL_MS: ${HEALTH_PROBE_INTERVAL_MS:-300000}
      HEALTH_PROBE_TIMEOUT_MS: ${HEALTH_PROBE_TIMEOUT_MS:-5000}
      HEALTH_PROBE_CONCURRENCY: ${HEALTH_PROBE_CONCURRENCY:-4}
    depends_on:
      postgres:
        condition: service_healthy
    networks:
      - portal-net
```

Run with `docker compose up -d health-probe` alongside the main `app`
service.

---

## 6. QA / smoke

```bash
# 1. One-shot run, JSON output — useful for the smoke script:
npx tsx scripts/health-probe.ts --once --json

# 2. Manual "check now" via the internal route:
curl -sS -H "x-kairikos-internal-key: $PORTAL_API_KEY" \
  http://localhost:3001/api/internal/health-probe/run | jq

# 3. The portal_api_key probe's own ping (used by the probe internally):
curl -sS -H "x-kairikos-internal-key: $PORTAL_API_KEY" \
  http://localhost:3001/api/internal/health-probe/ping
```

Expected response shape:

```json
{
  "ok": true,
  "results": [
    { "toolKey": "n8n", "status": "healthy", "durationMs": 142, "previousStatus": "healthy", "stateChanged": false },
    { "toolKey": "resend", "status": "degraded", "durationMs": 5012, "error": "resend status 503", "previousStatus": "healthy", "stateChanged": true }
  ]
}
```

---

## 7. Status semantics

| Status | Meaning | UI badge |
| --- | --- | --- |
| `healthy` | Probe succeeded inside the timeout. | green |
| `degraded` | Probe succeeded but slowly, returned 4xx (non-auth), or timed out. The integration is reachable but the operator should look. | yellow |
| `failed` | Probe returned 401/403, threw a connection error, or the credential is missing. The integration is broken right now. | red |
| `unknown` | No probe is configured for this `toolKey` (or the probe endpoint returned 404). The UI shows a "no probe configured" hint. | gray |

---

## 8. Out of scope (deliberately)

- **Alerting.** The settings page surfaces the state. Emailing the
  operator when an integration is `failed` for >N minutes is a
  separate ticket — the spec is `POST /api/internal/notify-operator`
  with `kind: 'health-degraded'`, but that needs a separate decision on
  per-toolKey alert thresholds.
- **Probes for tools outside the current four** (Stripe, custom
  webhooks, etc.). Added as new `toolKey` rows appear — each is a
  small `async (row, ctx) => ProbeOutcome` function in
  `health-probe.ts` plus an entry in the `PROBES` dispatch table.
- **TOTP step-up.** The settings page write path (KAIA-1109) gates
  mutations behind TOTP, but the probes themselves are automated and
  need no operator interaction.

---

## 9. References

- Parent: [KAIA-1058](/KAIA/issues/KAIA-1058) (operator dashboard
  Option B; this worker is the operator-observability play).
- Sibling: [KAIA-1106](/KAIA/issues/KAIA-1106) (`OperatorSettings` +
  `OperatorSettingsAudit` Prisma models — the worker writes to them).
- Sibling: [KAIA-1109](/KAIA/issues/KAIA-1109) (settings API; the
  `portal_api_key` probe calls it).
- Internal auth pattern: [KAIA-1061](/KAIA/issues/KAIA-1061)
  (`/api/internal/notify-operator`) — the same shared-secret scheme.
- Lens reminder: MTTD/MTTR over MTBF — fast detection and recovery,
  not perfect uptime.
