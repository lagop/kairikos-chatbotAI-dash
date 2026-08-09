#!/usr/bin/env bash
# scripts/apply-kaia-13281-migration.sh
#
# KAIA-13281 — Apply the OperatorAction audit table + ChatbotClient.notes
# migration (portal/prisma/migrations/20260809190000_kaia_13281_operator_action/migration.sql)
# against staging via the Supabase Management API
# (POST /v1/projects/{ref}/database/query).
#
# Strategy: the Management API runs one statement per call. We split
# the migration on `;` boundaries outside dollar-quoted strings,
# outside single-quoted strings, and outside double-quoted strings,
# then send each chunk separately.
#
# The migration is itself idempotent (CREATE TABLE IF NOT EXISTS,
# CREATE INDEX IF NOT EXISTS, ALTER TABLE ... ADD COLUMN IF NOT EXISTS,
# and a DO-block guard around the FK constraint), so re-running this
# script is safe.
#
# Usage:
#   scripts/apply-kaia-13281-migration.sh
#
# Exit codes:
#   0 — applied (idempotent re-runs are no-ops)
#   1 — env not populated
#   2 — Management API call failed (non-idempotent error)
#   3 — migration file missing

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"
MIG_FILE="$REPO_ROOT/portal/prisma/migrations/20260809190000_kaia_13281_operator_action/migration.sql"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

: "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN not set}"
: "${SUPABASE_URL:?SUPABASE_URL not set}"
PROJECT_REF="$(printf '%s' "$SUPABASE_URL" | sed -nE 's#^https?://([a-z0-9]+)\.supabase\.co/?$#\1#p')"
: "${PROJECT_REF:?could not parse project ref from SUPABASE_URL}"

[[ -f "$MIG_FILE" ]] || { echo "FATAL: $MIG_FILE missing" >&2; exit 3; }

log() { printf '%s %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"; }

# Step 1 — strip SQL comments so `;` inside them isn't a separator.
# Comments are `--` to EOL. The DO-block we keep (it's a single statement
# from the API's point of view — no top-level `;` inside the body that
# would break the splitter).
TMP_NO_COMMENTS=/tmp/kaia-13281-nocomments.sql
sed -E 's/--.*$//' "$MIG_FILE" > "$TMP_NO_COMMENTS"

# Step 2 — split into statements using a state machine in awk. State:
# inside_dollar, inside_single_quote, inside_double_quote. `;` at the
# top level terminates a statement. We honour $$ ... $$ dollar quoting
# so the DO-block body's semicolons stay bundled.
awk '
  BEGIN {
    in_dollar = 0
    in_single = 0
    in_double = 0
    stmt = ""
  }
  {
    line = $0
    i = 1
    n = length(line)
    while (i <= n) {
      ch = substr(line, i, 1)
      next_ch = (i < n) ? substr(line, i + 1, 1) : ""

      if (in_dollar) {
        if (ch == "$" && next_ch == "$") {
          in_dollar = 0
          stmt = stmt "$$"
          i += 2
          continue
        }
        stmt = stmt ch
        i++
        continue
      }
      if (in_single) {
        if (ch == "\x27") {
          in_single = 0
        }
        stmt = stmt ch
        i++
        continue
      }
      if (in_double) {
        if (ch == "\"") {
          in_double = 0
        }
        stmt = stmt ch
        i++
        continue
      }
      # Not inside any quote.
      if (ch == "$" && next_ch == "$") {
        in_dollar = 1
        stmt = stmt "$$"
        i += 2
        continue
      }
      if (ch == "\x27") {
        in_single = 1
        stmt = stmt ch
        i++
        continue
      }
      if (ch == "\"") {
        in_double = 1
        stmt = stmt ch
        i++
        continue
      }
      if (ch == ";") {
        out = stmt
        sub(/^[[:space:]]+/, "", out)
        sub(/[[:space:]]+$/, "", out)
        if (out != "") {
          print out
        }
        stmt = ""
        i++
        continue
      }
      stmt = stmt ch
      i++
    }
    if (stmt != "" && stmt !~ /^[[:space:]]*$/) {
      stmt = stmt " "
    }
  }
  END {
    out = stmt
    sub(/^[[:space:]]+/, "", out)
    sub(/[[:space:]]+$/, "", out)
    if (out != "") print out
  }
' "$TMP_NO_COMMENTS" > /tmp/kaia-13281-stmts.txt

TOTAL=$(wc -l < /tmp/kaia-13281-stmts.txt)
log "split into $TOTAL statements (file $MIG_FILE)"
log "target project: $PROJECT_REF"

APPLIED=0
SKIPPED=0
i=0
while IFS= read -r stmt; do
  i=$((i + 1))
  trimmed="$stmt"
  if [[ -z "${trimmed// /}" ]]; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi
  log "[$i/$TOTAL] ${trimmed:0:120}"
  PAYLOAD=$(jq -nc --arg q "$trimmed" '{query: $q}')
  HTTP=$(curl -sS -o /tmp/kaia-13281-resp.json -w '%{http_code}' \
    -X POST "https://api.supabase.com/v1/projects/$PROJECT_REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" --max-time 60)
  RESP=$(cat /tmp/kaia-13281-resp.json)
  if [[ "$HTTP" == "201" || "$HTTP" == "200" ]]; then
    APPLIED=$((APPLIED + 1))
    if [[ -n "$RESP" && "$RESP" != "[]" && "$RESP" != "null" ]]; then
      log "  -> ok: ${RESP:0:200}"
    fi
  else
    log "  -> HTTP $HTTP body: $RESP"
    case "$RESP" in
      *already\ exists*|*duplicate\ key*|*does\ not\ exist*|*already\ defined*)
        log "  -> non-fatal (idempotent)"
        SKIPPED=$((SKIPPED + 1))
        ;;
      *)
        echo "FATAL: statement $i failed: $RESP" >&2
        exit 2
        ;;
    esac
  fi
done < /tmp/kaia-13281-stmts.txt

log "=== summary: applied=$APPLIED skipped=$SKIPPED total=$TOTAL ==="
log "evidence: applied=$APPLIED skipped=$SKIPPED project=$PROJECT_REF migration=20260809190000_kaia_13281_operator_action"
