# KAIA-8083 Smoke Evidence — ds-product-reviews webhook scenarios

**Date:** 2026-08-01
**Run:** b8846816-cf49-4e75-9fd0-39c3d383bb2d

## Scenarios Run

### 1. HMAC Bad Signature → HTTP 401 ✅
```bash
scenario=hmac-bad bash automations/ds-product-reviews/scripts/run-scenario.sh
```
```
HTTP 401
{"success":false,"scenario":"bad-sig","expected":"0bda99887543fe12b92a7390e1ba996603849c269a5ceacb20ea8b6f4c8892e6","provided":"0000000000000000000000000000000000000000000000000000000000000000","payload_len":128}
```

### 2. HMAC OK (valid signature) → HTTP 202 ✅
```bash
scenario=hmac-ok bash automations/ds-product-reviews/scripts/run-scenario.sh
```
```
HTTP 202
{"success":true,"scenario":"hmac-ok","hmac":"0bda99887543fe12b92a7390e1ba996603849c269a5ceacb20ea8b6f4c8892e6","payload_len":128}
```

### 3. Cadence/Replay → HTTP 202 (NOT 429) ❌
```bash
scenario=no-cadence bash automations/ds-product-reviews/scripts/run-scenario.sh  # ×2 in rapid succession
```
Result: Both returned `HTTP 202` with `success:true`.
The 429 rate-limit was NOT reproduced. Per the continuation scope, triggering the 429
requires `WHATSAPP_DAILY_BUDGET_CENTS=1` to be set in the n8n relay environment — an
Automation Engineer action outside this smoke scope.

### 4. Unknown Business → HTTP 202 (NOT 404) ❌
```bash
scenario=unknown-biz bash automations/ds-product-reviews/scripts/run-scenario.sh
# business_id=does-not-exist-<RANDOM>
```
Result: `HTTP 202` with `success:true`.
The expected 404 was NOT reproduced. The n8n send workflow (`ds-rev-request-schedule`)
appears to accept requests even for businesses not present in `reviews_configs`.
The 404 scenario in the runbook (§4) applies to the inbound webhook
(`/webhook/ds-rev-received-inbound`), not the send webhook.

### 5. Inbound Rating with Invalid Token → HTTP 500 (NOT 404) ❌
```bash
# POST /webhook/ds-rev-received-inbound with rating_token not in DB
curl -X POST "https://n8n.srv1170607.hstgr.cloud/webhook/ds-rev-received-inbound" \
  -H 'Content-Type: application/json' \
  -H "x-dashboard-signature: sha256=<valid-hmac>" \
  -d '{"rating_token":"invalid-token-12345678901234567890","rating":5}'
```
Result: `HTTP 500 {"message":"Workflow execution failed"}`
Expected per runbook §4: `HTTP 404 not_found`.
Actual: `HTTP 500` — the n8n workflow is failing unhandled when the rating_token
is not found in `reviews_requests`.

## Database State (Supabase staging: ikexqreuvoqwvwopftkt)
```
SELECT count(*) FROM chatbot_clients;      → 0
SELECT count(*) FROM reviews_configs;      → 0
SELECT count(*) FROM reviews_requests;     → 0
SELECT count(*) FROM reviews_received;     → 0
```
All four tables are empty. The `reviews_configs.business_id` FK to
`chatbot_clients(id)` cannot be satisfied without seeding data.

## Blockers for Full Smoke Completion

| Scenario | Blocker | Owner |
|----------|---------|-------|
| 429 rate-limit | `WHATSAPP_DAILY_BUDGET_CENTS=1` not set in n8n relay | Automation Engineer |
| 200 end-to-end | Empty staging DB — needs `chatbot_clients` + `reviews_configs` fixture | Automation Engineer |
| 404 (inbound) | n8n workflow returns `500` instead of `404` for unknown rating_token | Automation Engineer |

## Commit Evidence
```
commit 151dabe0290405ebb8284a7dfa1178f1d7e95428
test: capture product reviews smoke evidence
evidence/KAIA-8083/429-200-404.txt | 8 lines
```
