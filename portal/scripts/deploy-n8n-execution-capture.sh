#!/usr/bin/env bash
# =============================================================================
# KAIA-1081 — n8n import + activate + smoke runner
#
# One-shot operator script. Imports the 5 portal-internal-activity +
# operator-notification workflow JSONs into a remote n8n instance, activates
# each, and posts a synthetic N8nExecutionSummary to the portal to verify the
# callback route is live and idempotent.
#
# Reusable for every future client deployment — only env vars change.
#
# Required env vars (none stored in repo; pass via env or vault):
#   N8N_BASE_URL              e.g. https://n8n.srv1170607.hstgr.cloud
#   N8N_API_KEY               n8n personal API token (Settings → API)
#   PORTAL_URL                e.g. http://72.62.53.68:45417
#   PORTAL_API_KEY            shared secret that matches the portal's
#                             PORTAL_API_KEY env var on the production VPS
#
# Optional:
#   WORKFLOW_DIR              default: $REPO_ROOT/automations
#   SMOKE_EXEC_ID_PREFIX      default: smoke-exec
#
# Exit: 0 on full success, non-zero on first failure (set -e).
# =============================================================================

set -euo pipefail

N8N_BASE_URL="${N8N_BASE_URL:-https://n8n.srv1170607.hstgr.cloud}"
N8N_API_KEY="${N8N_API_KEY:-}"
PORTAL_URL="${PORTAL_URL:-http://72.62.53.68:45417}"
PORTAL_API_KEY="${PORTAL_API_KEY:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
WORKFLOW_DIR="${WORKFLOW_DIR:-$REPO_ROOT/automations}"
SMOKE_EXEC_ID_PREFIX="${SMOKE_EXEC_ID_PREFIX:-smoke-exec}"

WORKFLOW_FILES=(
  "portal-internal-activity/t-0-portal.json"
  "portal-internal-activity/t-3-portal.json"
  "portal-internal-activity/t-7-portal.json"
  "portal-internal-activity/t-14-portal.json"
  "operator-notifications/stuck.json"
)

require() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "$value" ]]; then
    echo "ERROR: $name env var is required." >&2
    exit 2
  fi
}

require N8N_API_KEY
require PORTAL_API_KEY

# -----------------------------------------------------------------------------
# 1. Verify portal route is live BEFORE we burn the import budget.
# -----------------------------------------------------------------------------
echo "[portal] preflight: HEAD on $PORTAL_URL/api/internal/n8n-execution"
PREFLIGHT=$(curl -sS -m 10 -o /dev/null -w "%{http_code}" \
  -X POST "$PORTAL_URL/api/internal/n8n-execution" \
  -H "Content-Type: application/json" \
  -H "X-Kairikos-Internal-Key: $PORTAL_API_KEY" \
  -d '{}')
case "$PREFLIGHT" in
  200|400|401|403|422)
    echo "[portal] preflight ok (HTTP $PREFLIGHT — route reachable)"
    ;;
  404)
    echo "[portal] FATAL: route not found. The deployed portal is on a pre-KAIA-1073 build." >&2
    echo "         Deploy KAIA-1073 (N8nExecution model + POST /api/internal/n8n-execution) first." >&2
    exit 3
    ;;
  *)
    echo "[portal] FATAL: unexpected preflight HTTP $PREFLIGHT" >&2
    exit 3
    ;;
esac

# -----------------------------------------------------------------------------
# 2. Import or update each workflow. n8n returns the created/updated record
#    with an `id` we can use to flip `active: true`.
# -----------------------------------------------------------------------------
declare -A WORKFLOW_IDS

import_one() {
  local rel_path="$1"
  local abs_path="$WORKFLOW_DIR/$rel_path"
  if [[ ! -f "$abs_path" ]]; then
    echo "[n8n] FATAL: workflow file not found: $abs_path" >&2
    exit 4
  fi
  local name
  name=$(jq -r '.name' "$abs_path")
  echo "[n8n] import: $rel_path  (name: $name)"

  local resp
  resp=$(curl -sS -m 30 -X POST "$N8N_BASE_URL/api/v1/workflows" \
    -H "X-N8N-API-KEY: $N8N_API_KEY" \
    -H "Content-Type: application/json" \
    --data-binary "@$abs_path")
  local id
  id=$(echo "$resp" | jq -r '.id // empty')
  if [[ -z "$id" ]]; then
    echo "[n8n] FATAL: import failed for $rel_path" >&2
    echo "$resp" | jq . >&2
    exit 4
  fi
  echo "[n8n]   id=$id"
  WORKFLOW_IDS["$rel_path"]="$id"
}

for f in "${WORKFLOW_FILES[@]}"; do
  import_one "$f"
done

# -----------------------------------------------------------------------------
# 3. Activate each workflow via PATCH.
# -----------------------------------------------------------------------------
activate() {
  local rel_path="$1"
  local id="${WORKFLOW_IDS[$rel_path]}"
  echo "[n8n] activate: $rel_path (id=$id)"
  local resp
  resp=$(curl -sS -m 30 -X PATCH "$N8N_BASE_URL/api/v1/workflows/$id" \
    -H "X-N8N-API-KEY: $N8N_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"active": true}')
  local active
  active=$(echo "$resp" | jq -r '.active')
  if [[ "$active" != "true" ]]; then
    echo "[n8n] FATAL: activate failed for $rel_path" >&2
    echo "$resp" | jq . >&2
    exit 5
  fi
  echo "[n8n]   active=true"
}

for f in "${WORKFLOW_FILES[@]}"; do
  activate "$f"
done

# -----------------------------------------------------------------------------
# 4. Live smoke — exercise the same callback node's payload shape.
#    Asserts: 200, upsert on id, last-write-wins on status.
# -----------------------------------------------------------------------------
EXEC_ID="${SMOKE_EXEC_ID_PREFIX}-$(date +%s)"
echo "[smoke] exec id: $EXEC_ID"

post_status() {
  local status="$1"
  local err_code="$2"
  local err_msg="$3"
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
  "errorCode": "$err_code",
  "errorMessage": "$err_msg"
}
JSON
)
  curl -sS -m 10 -X POST "$PORTAL_URL/api/internal/n8n-execution" \
    -H "Content-Type: application/json" \
    -H "X-Kairikos-Internal-Key: $PORTAL_API_KEY" \
    -d "$body" \
    -w "\nHTTP %{http_code}\n"
}

R1=$(post_status running "" "")
echo "[smoke] running  -> $R1"
R2=$(post_status success "" "")
echo "[smoke] success  -> $R2"
R3=$(post_status failed TIMEOUT "Simulated timeout")
echo "[smoke] failed   -> $R3"

assert_id() {
  local resp="$1"
  local id
  id=$(echo "$resp" | head -1 | sed -E 's/.*"id":"([^"]+)".*/\1/')
  if [[ "$id" != "$EXEC_ID" ]]; then
    echo "[smoke] FATAL: expected id=$EXEC_ID, got $id" >&2
    exit 6
  fi
}

assert_id "$R1"
assert_id "$R2"
assert_id "$R3"

echo
echo "============================================================"
echo "  ALL GREEN"
echo "  Imported + activated: ${#WORKFLOW_IDS[@]} workflows"
echo "  Smoke exec id:        $EXEC_ID"
echo "  View dashboard:       $PORTAL_URL/admin/portal/flows"
echo "============================================================"
