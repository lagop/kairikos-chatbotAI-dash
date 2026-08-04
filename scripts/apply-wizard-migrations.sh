#!/usr/bin/env bash
# scripts/apply-wizard-migrations.sh
#
# KAIA-10138 — Apply the wizard schema migrations from
# `feat/kaia-4263-onboarding-wizard` to the Supabase project that the
# Vercel preview connects to at runtime (same DB as staging ref
# `ikexqreuvoqwvwopftkt`).
#
# The two migrations we need are:
#   portal/prisma/migrations/20260801100000_onboarding_session/migration.sql
#   portal/prisma/migrations/20260801100500_onboarding_funnel_events/migration.sql
#
# This helper reuses the same Supabase Management API approach as
# `scripts/apply-billing-prisma-migration.sh` (KAIA-8107), but iterates
# across both migration files in order. Each migration uses `CREATE TABLE
# IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`, so re-running this helper
# against an already-applied DB is a no-op.
#
# Strategy:
#   1. Sanity-check the Supabase env vars + parse the project ref.
#   2. Split each .sql file on `;` boundaries outside quotes/dollar-blocks.
#   3. POST each statement to /v1/projects/{ref}/database/query.
#   4. Treat already-exists / duplicate-key / does-not-exist as non-fatal
#      (idempotent re-application). Hard-fail on anything else.
#   5. Write evidence to /tmp/kaia-10138-*.log so the post-status comment
#      helper can verify the apply by reading the captured HTTP codes.
#
# Exit codes:
#   0 — applied (or all idempotent skips; migration is now reflected on the DB)
#   1 — env not populated
#   2 — Supabase API call failed on a non-idempotent error
#   3 — migration file missing

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"

# Pull a list of migration paths in apply order from $@ or default to the
# two wizard migrations in cron order.
if [[ $# -gt 0 ]]; then
  MIG_FILES=("$@")
else
  MIG_FILES=(
    "$REPO_ROOT/portal/prisma/migrations/20260801100000_onboarding_session/migration.sql"
    "$REPO_ROOT/portal/prisma/migrations/20260801100500_onboarding_funnel_events/migration.sql"
  )
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

: "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN not set}"
: "${SUPABASE_URL:?SUPABASE_URL not set}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY not set}"
PROJECT_REF="$(printf '%s' "$SUPABASE_URL" | sed -nE 's#^https?://([a-z0-9]+)\.supabase\.co/?$#\1#p')"
: "${PROJECT_REF:?could not parse project ref from SUPABASE_URL}"

log()  { printf '%s kaia-10138 %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"; }
fail() { printf 'FATAL: %s\n' "$*" >&2; exit "${2:-1}"; }

for f in "${MIG_FILES[@]}"; do
  [[ -f "$f" ]] || fail "migration file missing: $f" 3
done

# Quick proof of life: confirm we can authenticate against the API.
PING_CODE=$(curl -sS -o /tmp/kaia-10138-ping.json -w '%{http_code}' \
  -X POST "https://api.supabase.com/v1/projects/$PROJECT_REF/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"select current_database() || $$|$$ || current_user"}' \
  --max-time 60)
[[ "$PING_CODE" == "200" || "$PING_CODE" == "201" ]] \
  || { cat /tmp/kaia-10138-ping.json >&2; fail "DB ping returned HTTP $PING_CODE"; }
log "ping ok project=$PROJECT_REF body=$(cat /tmp/kaia-10138-ping.json | head -c 200)"

# Split the SQL files the same way apply-billing-prisma-migration.sh does
# (state machine in awk keeps dollar/quote balance; strips -- comments).
split_sql() {
  local src="$1" out="$2"
  local tmp_nc
  tmp_nc="$(mktemp -t kaia10138-nc-XXXXXX.sql)"
  sed -E 's/--.*$//' "$src" > "$tmp_nc"
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
  ' "$tmp_nc" > "$out"
  rm -f "$tmp_nc"
}

OVERALL_APPLIED=0
OVERALL_SKIPPED=0
OVERALL_TOTAL=0

for MIG_FILE in "${MIG_FILES[@]}"; do
  REL="${MIG_FILE#$REPO_ROOT/}"
  STEM="$(basename "$(dirname "$MIG_FILE")")"
  OUT_STMTS="/tmp/kaia-10138-stmts-${STEM}.txt"
  OUT_LOG="/tmp/kaia-10138-${STEM}.log"

  split_sql "$MIG_FILE" "$OUT_STMTS"
  TOTAL=$(wc -l < "$OUT_STMTS")
  log "$REL split into $TOTAL statements"

  APPLIED=0; SKIPPED=0; i=0
  : > "$OUT_LOG"
  while IFS= read -r stmt; do
    i=$((i + 1))
    trimmed="$stmt"
    [[ -z "${trimmed// /}" ]] && { SKIPPED=$((SKIPPED + 1)); continue; }
    log "[$STEM $i/$TOTAL] ${trimmed:0:120}"
    PAYLOAD=$(jq -nc --arg q "$trimmed" '{query: $q}')
    HTTP=$(curl -sS -o /tmp/kaia-10138-resp.json -w '%{http_code}' \
      -X POST "https://api.supabase.com/v1/projects/$PROJECT_REF/database/query" \
      -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
      -H "Content-Type: application/json" \
      -d "$PAYLOAD" --max-time 60)
    RESP=$(cat /tmp/kaia-10138-resp.json)
    if [[ "$HTTP" == "201" || "$HTTP" == "200" ]]; then
      APPLIED=$((APPLIED + 1))
      if [[ -n "$RESP" && "$RESP" != "[]" && "$RESP" != "null" ]]; then
        log "  -> ok: ${RESP:0:200}"
        printf '%s [%s] %s | http %s | %s\n' "$(date -u +'%H:%M:%SZ')" "$STEM" "$i" "$HTTP" "${RESP:0:200}" >> "$OUT_LOG"
      else
        printf '%s [%s] %s | http %s\n' "$(date -u +'%H:%M:%SZ')" "$STEM" "$i" "$HTTP" >> "$OUT_LOG"
      fi
    else
      log "  -> HTTP $HTTP body: $RESP"
      printf '%s [%s] %s | http %s | %s\n' "$(date -u +'%H:%M:%SZ')" "$STEM" "$i" "$HTTP" "$RESP" >> "$OUT_LOG"
      case "$RESP" in
        *already\ exists*|*duplicate\ key*|*does\ not\ exist*|*already\ defined*)
          log "  -> non-fatal (idempotent)"
          SKIPPED=$((SKIPPED + 1))
          ;;
        *)
          fail "statement $i failed on $REL: $RESP" 2
          ;;
      esac
    fi
  done < "$OUT_STMTS"

  log "$REL: applied=$APPLIED skipped=$SKIPPED total=$TOTAL"
  OVERALL_APPLIED=$((OVERALL_APPLIED + APPLIED))
  OVERALL_SKIPPED=$((OVERALL_SKIPPED + SKIPPED))
  OVERALL_TOTAL=$((OVERALL_TOTAL + TOTAL))
done

log "=== summary: applied=$OVERALL_APPLIED skipped=$OVERALL_SKIPPED total=$OVERALL_TOTAL project=$PROJECT_REF ==="
printf '%s\n' "applied=$OVERALL_APPLIED skipped=$OVERALL_SKIPPED total=$OVERALL_TOTAL project=$PROJECT_REF"
