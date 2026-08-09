#!/usr/bin/env bash
# scripts/apply-kaia-13281-migration.sh
#
# Apply the KAIA-13281 migration (OperatorAction + ChatbotClient.notes)
# to the staging Supabase project via the Management API. Mirrors the
# split-and-execute pattern of scripts/apply-billing-migration.sh.
#
# Idempotency: every statement in the migration is `IF NOT EXISTS`
# (CREATE TABLE, ADD COLUMN, CREATE INDEX). Re-runs are no-ops.
#
# Exit codes:
#   0 — applied (idempotent re-runs are no-ops)
#   1 — env not populated
#   2 — Management API call failed (non-idempotent error)
#   3 — migration file missing

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIG_FILE="$REPO_ROOT/portal/prisma/migrations/20260809174654_operator_action_and_client_notes/migration.sql"

: "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN not set}"
: "${SUPABASE_URL:?SUPABASE_URL not set}"
PROJECT_REF="$(printf '%s' "$SUPABASE_URL" | sed -nE 's#^https?://([a-z0-9]+)\.supabase\.co/?$#\1#p')"
: "${PROJECT_REF:?could not parse project ref from SUPABASE_URL}"

[[ -f "$MIG_FILE" ]] || { echo "FATAL: $MIG_FILE missing" >&2; exit 3; }

log() { printf '%s %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"; }

log "Applying KAIA-13281 migration to $PROJECT_REF"
log "Migration file: $MIG_FILE"

# Send the whole migration as a single transaction. The Management API
# accepts multi-statement bodies; the `IF NOT EXISTS` guards make this
# safe to re-run.
TMP_BODY=$(mktemp)
jq -n --arg q "$(cat "$MIG_FILE")" '{query: $q}' > "$TMP_BODY"

RESP=$(curl -sS -X POST \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary "@$TMP_BODY" \
  "https://api.supabase.com/v1/projects/$PROJECT_REF/database/query" \
  -w '\nHTTP_STATUS:%{http_code}\n')
rm -f "$TMP_BODY"

echo "$RESP"
STATUS_LINE=$(printf '%s\n' "$RESP" | awk -F: '/^HTTP_STATUS:/{print $2; exit}')
if [[ "$STATUS_LINE" != "200" && "$STATUS_LINE" != "201" ]]; then
  log "FAIL: Management API returned HTTP $STATUS_LINE"
  exit 2
fi
log "OK: Migration applied (HTTP $STATUS_LINE)"