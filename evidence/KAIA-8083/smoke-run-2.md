# KAIA-8083 Smoke Run #2 — 2026-08-01 (post-DB-seed)

**Run:** b8846816-cf49-4e75-9fd0-39c3d383bb2d (continuation)
**Endpoint:** `https://n8n.srv1170607.hstgr.cloud/webhook/ds-rev-request-schedule`
**Inbound endpoint:** `https://n8n.srv1170607.hstgr.cloud/webhook/ds-rev-received-inbound`

## DB state at start of run (re-verified)
```
chatbot_clients   → 1 row (id: 340e1cc6-593a-4362-8c6d-2034dfe356c8)
reviews_configs   → 1 row (active=true, cadence_days=7)
reviews_requests  → 3 rows (all status=sent, real rating_tokens present)
reviews_received  → 0 rows
```
✅ DB fixture is now seeded. Previous blocker (empty DB) is RESOLVED.

## Scenarios

### A. Send webhook (production: `KdSaL475gGX8Tn1O`)

The active workflow on the webhook path is the **smoke probe** `IaJHBERoF4ku1gpt`
(not the production `KdSaL475gGX8Tn1O`). The smoke probe only validates HMAC
and returns 202 for any valid signature — it does NOT do cadence enforcement
or business lookup. This is a known constraint per the issue scope.

| Scenario | Result | HTTP | Notes |
|----------|--------|------|-------|
| A1. HMAC bad sig | ✅ | 401 | confirmed |
| A2. HMAC valid, fresh phone | ✅ | 202 | smoke probe accepts |
| A3. HMAC valid, same phone (cadence) | ❌ | 202 | smoke probe doesn't enforce cadence; expects 429 |
| A4. HMAC valid, unknown business | ❌ | 202 | smoke probe doesn't validate business; expects 404 or 502 |

The smoke probe cannot reproduce 429 or 404 because it doesn't have those
response nodes. The production workflow JSON
(`reviews-request-from-dashboard.json`) DOES have `Rate-Limited Response (429)`
and `Not Found Response` would be needed but is not present (only 400/429/502
exist in the send workflow). The 404 in the issue scope applies to the
**inbound** webhook, not the send webhook.

### B. Inbound webhook (production: `ds-rev-received-inbound`)

| Scenario | Result | HTTP | Notes |
|----------|--------|------|-------|
| B1. Valid rating_token (`rt_seed_rl_8088`) | ❌ | 500 | `Workflow execution failed`; no row in `reviews_received` |
| B2. Invalid rating_token | ❌ | 500 | `Workflow execution failed`; same as B1 |

Both inbound POSTs return `HTTP 500 "Workflow execution failed"`.
The workflow JSON (`reviews-received-inbound.json`) HAS a `Not Found Response (404)`
node, but the deployed workflow crashes before reaching it. The `reviews_received`
table remains empty after both POSTs.

## Blocker Status Update

| Blocker | Previous | Current | Owner |
|---------|----------|---------|-------|
| Empty DB | open | ✅ RESOLVED | Automation Engineer (seeded) |
| 429 cadence (smoke probe lacks logic) | open | open | Automation Engineer (activate `KdSaL475gGX8Tn1O` or add cadence to probe) |
| 404 send-webhook (no 404 node in workflow) | open | open | Automation Engineer (add 404 response or switch to active production workflow) |
| Inbound 500 (workflow bug) | open | open | Automation Engineer (fix workflow error handling) |

## Conclusion

The DB is now seeded with real fixtures, but the smoke probe workflow
(`IaJHBERoF4ku1gpt`) that owns the webhook path only validates HMAC.
The production workflows (`KdSaL475gGX8Tn1O` for send, `ds-rev-received-inbound`
for inbound) are either inactive or buggy. Three of four scenarios remain
blocked on Automation Engineer action.

The 401 and 202 (send HMAC-only) scenarios ARE confirmed and pass.
