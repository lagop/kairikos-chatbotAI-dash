#!/usr/bin/env bash
# scripts/apply-billing-prisma-migration.sh
#
# KAIA-4262 — Apply the portal Prisma migration to the production DB
# (which is the same Supabase Postgres where the Supabase mirror migration
# was already applied). The Prisma client uses PascalCase identifiers
# (Tenant, Subscription, Invoice, StripeWebhookEvent); the prior Supabase
# mirror migration used snake_case identifiers (subscriptions, invoices,
# stripe_webhook_events). Both sets of tables now coexist — the Prisma
# migration adds the PascalCase set.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"
MIG_FILE="$REPO_ROOT/portal/prisma/migrations/20260727150000_billing_subscriptions_invoices/migration.sql"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

: "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN not set}"
: "${SUPABASE_URL:?SUPABASE_URL not set}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY not set}"
PROJECT_REF="$(printf '%s' "$SUPABASE_URL" | sed -nE 's#^https?://([a-z0-9]+)\.supabase\.co/?$#\1#p')"
: "${PROJECT_REF:?could not parse project ref from SUPABASE_URL}"

[[ -f "$MIG_FILE" ]] || { echo "FATAL: $MIG_FILE missing" >&2; exit 3; }

log() { printf '%s %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"; }

# Strip SQL comments first
TMP_NO_COMMENTS=/tmp/kaia-4262-prisma-nocomments.sql
sed -E 's/--.*$//' "$MIG_FILE" > "$TMP_NO_COMMENTS"

# Split on `;` outside quotes/dollar-blocks
awk '
  BEGIN { in_dollar = 0; in_single = 0; in_double = 0; stmt = "" }
  {
    line = $0; i = 1; n = length(line)
    while (i <= n) {
      ch = substr(line, i, 1); next_ch = (i < n) ? substr(line, i + 1, 1) : ""
      if (in_dollar) {
        if (ch == "$" && next_ch == "$") { in_dollar = 0; stmt = stmt "$$"; i += 2; continue }
        stmt = stmt ch; i++; continue
      }
      if (in_single) { if (ch == "\x27") in_single = 0; stmt = stmt ch; i++; continue }
      if (in_double) { if (ch == "\"") in_double = 0; stmt = stmt ch; i++; continue }
      if (ch == "$" && next_ch == "$") { in_dollar = 1; stmt = stmt "$$"; i += 2; continue }
      if (ch == "\x27") { in_single = 1; stmt = stmt ch; i++; continue }
      if (ch == "\"") { in_double = 1; stmt = stmt ch; i++; continue }
      if (ch == ";") {
        out = stmt; sub(/^[[:space:]]+/, "", out); sub(/[[:space:]]+$/, "", out)
        if (out != "") print out
        stmt = ""; i++; continue
      }
      stmt = stmt ch; i++
    }
    if (stmt != "" && stmt !~ /^[[:space:]]*$/) stmt = stmt " "
  }
  END { out = stmt; sub(/^[[:space:]]+/, "", out); sub(/[[:space:]]+$/, "", out); if (out != "") print out }
' "$TMP_NO_COMMENTS" > /tmp/kaia-4262-prisma-stmts.txt

TOTAL=$(wc -l < /tmp/kaia-4262-prisma-stmts.txt)
log "split into $TOTAL statements (file $MIG_FILE)"
log "target project: $PROJECT_REF"

APPLIED=0; SKIPPED=0; i=0
while IFS= read -r stmt; do
  i=$((i + 1))
  trimmed="$stmt"
  [[ -z "${trimmed// /}" ]] && { SKIPPED=$((SKIPPED + 1)); continue; }
  log "[$i/$TOTAL] ${trimmed:0:120}"
  PAYLOAD=$(jq -nc --arg q "$trimmed" '{query: $q}')
  HTTP=$(curl -sS -o /tmp/kaia-4262-prisma-resp.json -w '%{http_code}' \
    -X POST "https://api.supabase.com/v1/projects/$PROJECT_REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" --max-time 60)
  RESP=$(cat /tmp/kaia-4262-prisma-resp.json)
  if [[ "$HTTP" == "201" || "$HTTP" == "200" ]]; then
    APPLIED=$((APPLIED + 1))
  else
    log "  -> HTTP $HTTP body: $RESP"
    case "$RESP" in
      *already\ exists*|*duplicate\ key*|*does\ not\ exist*|*already\ defined*)
        log "  -> non-fatal (idempotent)"
        SKIPPED=$((SKIPPED + 1))
        ;;
      *)
        echo "FATAL: statement $i failed: $RESP" >&2; exit 2
        ;;
    esac
  fi
done < /tmp/kaia-4262-prisma-stmts.txt

log "=== summary: applied=$APPLIED skipped=$SKIPPED total=$TOTAL ==="
log "evidence: applied=$APPLIED skipped=$SKIPPED project=$PROJECT_REF migration=20260727150000_billing_subscriptions_invoices (PascalCase)"