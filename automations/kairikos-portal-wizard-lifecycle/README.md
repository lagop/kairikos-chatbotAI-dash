# Kairikos Portal — Wizard Lifecycle Triggers (KAIA-1521)

> **Owner:** Automation Engineer
> **Parent:** [KAIA-1161](/KAI/issues/KAIA-1161)
> **BE-2 contract:** [KAIA-1517](/KAI/issues/KAIA-1517) (wizard routes + lifecycle internal routes)
> **Follow-up:** Portal must fire `config_complete` and `config_updated` webhooks (see §6)

## Overview

Three n8n workflows that wire the Kairikos portal's internal lifecycle routes to n8n:

| File                                                    | Trigger            | Portal endpoint consumed                        |
|---------------------------------------------------------|--------------------|------------------------------------------------|
| `kairikos-portal-wizard-scan.json`                      | Schedule (every 4h)| `POST /api/internal/wizard-abandoned/scan` +  |
|                                                         |                    | `POST /api/internal/review-overdue/scan`       |
| `kairikos-portal-config-complete-consumer.json`         | Webhook            | Portal fires on `config_complete` event        |
| `kairikos-portal-config-updated-consumer.json`          | Webhook            | Portal fires on `config_updated` event         |

---

## 1. `kairikos-portal-wizard-scan` — Polled scan + fire

**Trigger:** Schedule every 4 hours (`0 */4 * * *`)

**Architecture:** Single workflow that scans both `wizard-abandoned` and `review-overdue` on the same 4h cadence, then fires per candidate.

### Node chain

```
[ Schedule (every 4h) ]
       ↓
[ wizard-abandoned — Scan ]     POST /api/internal/wizard-abandoned/scan
       ↓
[ wizard-abandoned — Split Into Batches ]
       ↓
[ wizard-abandoned — Skip if alreadyFiredInWindow=true ]
       ↓ (false branch = process)
[ wizard-abandoned — Build Fire Payload ]
       ↓
[ wizard-abandoned — Fire ]     POST /api/internal/wizard-abandoned/fire
       ↓
[ Log Results ] ←←←←←←←←←←←←←←← (also receives review-overdue results)
[ Report Execution to Portal (KAIA-1073) ]
```

Parallel branch for `review-overdue` (same structure, different endpoints).

### Auth

- Header: `X-Kairikos-Internal-Key: {{ $env.PORTAL_API_KEY }}`
- `PORTAL_API_KEY` must be set in n8n credential vault before activation

### Idempotency

- Scan: `alreadyFiredInWindow` hint skips candidates the portal already fired for
- Fire: portal's `@@unique([clientId, milestone])` on `ChatbotActivity` is the source-of-truth dedup; retry is safe

### Env vars required (n8n vault)

| Variable            | Description                                          |
|---------------------|------------------------------------------------------|
| `PORTAL_API_URL`    | Base URL of the Kairikos portal (e.g. `https://portal.kairikos.com`) |
| `PORTAL_API_KEY`    | Shared secret — same value as `PORTAL_API_KEY` in portal `.env` |

---

## 2. `kairikos-portal-config-complete-consumer`

**Trigger:** Webhook `POST /webhook/kairikos-portal-config-complete`

**Note:** Requires portal-side implementation. See §6.

### Node chain

```
[ config_complete Webhook ]
       ↓
[ Verify Webhook Signature (HMAC-SHA256) ]
       ↓
[ Dedupe by eventId (Redis 24h TTL — belt-and-suspenders) ]
       ↓
[ Write ChatbotActivity (Supabase) ]   ← parallel
[ Send config_complete Email (Resend) ] ← parallel
       ↓
[ Log Result ]
[ Report Execution to Portal (KAIA-1073) ]
```

### Expected portal payload

```json
{
  "eventId": "evt_xxxx",
  "eventType": "config_complete",
  "clientId": "cuid",
  "companyName": "Peluquería Aurora",
  "contactEmail": "aurora@example.com",
  "contactName": "Aurora García",
  "tier": "pro",
  "completedAt": "2026-06-16T10:00:00.000Z",
  "stepsApproved": ["1", "2", "3", "4", "5"]
}
```

### Webhook signature

Portal signs the raw body with HMAC-SHA256 using `N8N_WEBHOOK_SHARED_SECRET`.
n8n verifies `X-Kairikos-Portal-Signature` header.

### Env vars required (n8n vault)

| Variable                    | Description                               |
|-----------------------------|-------------------------------------------|
| `N8N_WEBHOOK_SHARED_SECRET` | Shared secret for HMAC-SHA256 verification |
| `SUPABASE_URL`              | Supabase project URL                      |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (writes to `chatbot_activity`) |
| `RESEND_API_KEY`            | Resend API key (sends confirmation email) |
| `PORTAL_API_URL`            | Portal base URL (for KAIA-1073 reporting) |
| `PORTAL_API_KEY`            | Internal auth key (for KAIA-1073 reporting) |

---

## 3. `kairikos-portal-config-updated-consumer`

**Trigger:** Webhook `POST /webhook/kairikos-portal-config-updated`

**Note:** Requires portal-side implementation. See §6.

### Node chain

```
[ config_updated Webhook ]
       ↓
[ Verify Webhook Signature (HMAC-SHA256) ]
       ↓
[ Log Update (operator dashboard consumer) ]
[ Report Execution to Portal (KAIA-1073) ]
```

No downstream email — the operator dashboard is the sole consumer.

### Expected portal payload

```json
{
  "eventId": "evt_xxxx",
  "eventType": "config_updated",
  "clientId": "cuid",
  "companyName": "Peluquería Aurora",
  "operatorId": "op_xxxx",
  "stepKey": "3",
  "stepStatus": "submitted",
  "updatedAt": "2026-06-16T10:00:00.000Z"
}
```

### Env vars required (n8n vault)

| Variable                    | Description                               |
|-----------------------------|-------------------------------------------|
| `N8N_WEBHOOK_SHARED_SECRET` | Shared secret for HMAC-SHA256 verification |
| `PORTAL_API_URL`            | Portal base URL (for KAIA-1073 reporting) |
| `PORTAL_API_KEY`            | Internal auth key (for KAIA-1073 reporting) |

---

## 4. Credentials setup

**All credentials are stored in the n8n credential vault — never in workflow JSON.**

Before activating any workflow, set the following credentials in n8n:

1. **`PORTAL_API_KEY`** — the shared secret from the portal's `PORTAL_API_KEY` env var
2. **`N8N_WEBHOOK_SHARED_SECRET`** — set this in the portal's `.env` and the n8n vault; used for HMAC-SHA256 signature verification on consumer webhooks
3. **`SUPABASE_SERVICE_ROLE_KEY`** — Supabase service role key (only for the `config_complete` consumer)
4. **`RESEND_API_KEY`** — Resend API key (only for the `config_complete` consumer)

---

## 5. Import instructions

```bash
# Import each workflow via n8n UI:
#   Workflows → Import from File → select the .json file

# Or via n8n REST API:
N8N_BASE_URL=https://n8n.srvXXXX.hstgr.cloud
N8N_API_KEY=<your-n8n-api-key>

curl -X POST "$N8N_BASE_URL/api/v1/workflows" \
  -H "Authorization: Bearer $N8N_API_KEY" \
  -H "Content-Type: application/json" \
  -d @kairikos-portal-wizard-scan.json
```

After import:
1. Set the credential references in each node (the `$env.*` expressions will resolve once credentials are named in the vault)
2. Activate the workflows

---

## 6. Portal webhook firing — FOLLOW-UP REQUIRED

**Status: NOT YET IMPLEMENTED**

The portal currently does **not** fire `config_complete` or `config_updated` webhooks. The two consumer workflows are built and ready, but they cannot be tested until the portal implements the webhook firing.

**What the portal must do:**

### `config_complete` — fire when all mandatory wizard steps are approved

In the operator approval flow (`applyWizardReview` in `src/lib/wizard-review.ts`), after the final mandatory step is approved, the portal must fire a signed webhook:

```typescript
// After approve, check if all mandatory steps are now approved
const allApproved = await checkAllMandatoryStepsApproved(prisma, clientId);
if (allApproved) {
  await fireConfigCompleteWebhook(client, stepsApproved);
}
```

Webhook body: see §2 "Expected portal payload".

Sign with: `HMAC-SHA256(rawBody, N8N_WEBHOOK_SHARED_SECRET)` → header `X-Kairikos-Portal-Signature`

### `config_updated` — fire on every PATCH /api/portal/wizard/[step]

In `src/app/api/portal/wizard/[step]/route.ts` PATCH handler, after `saveWizardStep` returns successfully, fire:

```typescript
await fireConfigUpdatedWebhook(client, stepKey, newStatus);
```

**Owner for portal-side implementation:** Backend Developer (assign to a new child issue of KAIA-1521 or a dedicated BE ticket).

---

## 7. Acceptance criteria (AU-1)

- [ ] `wizard-abandoned` scan fires every 4h and correctly calls `/api/internal/wizard-abandoned/scan`
- [ ] `review-overdue` scan fires every 4h and correctly calls `/api/internal/review-overdue/scan`
- [ ] Per-candidate fire calls succeed with `deduped: true` on replay (portal idempotency verified)
- [ ] Consumer webhooks reject unsigned requests with 401 (signature verification tested)
- [ ] No secrets in the exported workflow JSON
- [ ] Portal `config_complete` and `config_updated` webhook firing implemented (follow-up)

---

## 8. Reusability

These three workflows are **client-agnostic** — they read `clientId` from the scan response or webhook payload, not from hardcoded values. The next Kairikos Chatbot AI client onboarding takes ~5 minutes:

1. Import the three JSON files into n8n
2. Set `PORTAL_API_URL`, `PORTAL_API_KEY`, and `N8N_WEBHOOK_SHARED_SECRET` in the n8n credential vault
3. Activate

No code changes. The workflows become the AU-1 reusable template across future Kairikos clients.

---

## 9. Related files

- `automations/wizard-lifecycle-triggers/README.md` — Kira Studio version (reference, do not modify)
- `automations/kairikos-portal-wizard-lifecycle/kairikos-portal-wizard-scan.json`
- `automations/kairikos-portal-wizard-lifecycle/kairikos-portal-config-complete-consumer.json`
- `automations/kairikos-portal-wizard-lifecycle/kairikos-portal-config-updated-consumer.json`
- `portal/src/app/api/internal/wizard-abandoned/scan/route.ts` — BE-2 scan route
- `portal/src/app/api/internal/wizard-abandoned/fire/route.ts` — BE-2 fire route
- `portal/src/app/api/internal/review-overdue/scan/route.ts` — BE-2 scan route
- `portal/src/app/api/internal/review-overdue/fire/route.ts` — BE-2 fire route
- `portal/src/lib/internal-auth.ts` — auth header contract (`X-Kairikos-Internal-Key`)
