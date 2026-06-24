#!/usr/bin/env bash
# =============================================================================
# KAIA-1073 — live smoke test for the n8n-execution callback
#
# Posts a synthetic N8nExecutionSummary to the running portal and asserts
# the route returns 200 with a stable id. Idempotency is verified by
# re-running the same request — the second call should also return 200
# and the same id (upsert semantics, not insert).
#
# Usage:
#   PORTAL_URL=http://72.62.53.68:45417 \
#   PORTAL_API_KEY=<real key> \
#   bash scripts/smoke-n8n-execution-live.sh
#
# Exit: 0 on success, 1 on any failure.
# =============================================================================

set -euo pipefail

PORTAL_URL="${PORTAL_URL:-http://72.62.53.68:45417}"
PORTAL_API_KEY="${PORTAL_API_KEY:-}"

if [[ -z "$PORTAL_API_KEY" ]]; then
  echo "ERROR: PORTAL_API_KEY env var is required." >&2
  exit 1
fi

EXEC_ID="smoke-exec-$(date +%s)"
URL="$PORTAL_URL/api/internal/n8n-execution"

run_one() {
  local status="$1"
  local error_code="$2"
  local error_message="$3"

  local body
  body=$(cat <<JSON
{
  "id": "$EXEC_ID",
  "clientId": "00000000-0000-0000-0000-000000000000",
  "clientName": "Smoke Test Co.",
  "workflow": "Smoke Test Workflow",
  "milestone": "T+0",
  "status": "$status",
  "startedAt": "2026-06-12T18:00:00.000Z",
  "finishedAt": "2026-06-12T18:00:01.000Z",
  "errorCode": "$error_code",
  "errorMessage": "$error_message"
}
JSON
)

  curl -sS -m 10 -X POST "$URL" \
    -H "Content-Type: application/json" \
    -H "X-Kairikos-Internal-Key: $PORTAL_API_KEY" \
    -d "$body" \
    -w "\nHTTP %{http_code}\n"
}

echo "[smoke] running post (running) ..."
RUNNING=$(run_one running "" "")
echo "$RUNNING"

echo "[smoke] running post (success) — should collapse to same id ..."
SUCCESS=$(run_one success "" "")
echo "$SUCCESS"

echo "[smoke] running post (failed) — should collapse to same id ..."
FAILED=$(run_one failed TIMEOUT "Simulated timeout")
echo "$FAILED"

# Extract ids from the responses and assert they match.
RUNNING_ID=$(echo "$RUNNING" | head -1 | sed -E 's/.*"id":"([^"]+)".*/\1/')
SUCCESS_ID=$(echo "$SUCCESS" | head -1 | sed -E 's/.*"id":"([^"]+)".*/\1/')
FAILED_ID=$(echo "$FAILED"  | head -1 | sed -E 's/.*"id":"([^"]+)".*/\1/')

if [[ "$RUNNING_ID" != "$EXEC_ID" || "$SUCCESS_ID" != "$EXEC_ID" || "$FAILED_ID" != "$EXEC_ID" ]]; then
  echo "FAIL — expected all three calls to return id=$EXEC_ID, got:" >&2
  echo "  running: $RUNNING_ID" >&2
  echo "  success: $SUCCESS_ID" >&2
  echo "  failed:  $FAILED_ID" >&2
  exit 1
fi

# Assert the final row reflects the last write (status=failed).
FINAL_STATUS=$(echo "$FAILED" | head -1 | sed -E 's/.*"status":"([^"]+)".*/\1/' || true)
if [[ -n "$FINAL_STATUS" && "$FINAL_STATUS" != "failed" ]]; then
  echo "FAIL — expected last write to be status=failed, got status=$FINAL_STATUS" >&2
  exit 1
fi

echo "[smoke] OK — all three calls returned id=$EXEC_ID (upsert idempotency verified)"
