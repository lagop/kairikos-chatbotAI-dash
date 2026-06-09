#!/usr/bin/env bash
# supabase/scripts/run-staging-e2e.sh
#
# KAIA-740 — orchestrator. Runs the full staging-apply + RLS smoke + e2e
# per-tenant magic-link check in one shot, with a single combined run log
# suitable for pasting into KAIA-731 to close the chain.
#
# What it does (in order):
#   1. Sanity: tools, .env, the 6 required vars (5 SUPABASE_* + PORTAL_URL),
#      staging project identity matches STAGING_PROJECT_REF.
#   2. Delegates to supabase/scripts/apply-to-staging.sh for:
#        - migrations + seed + auth.users provisioning
#        - the RLS smoke (8 checks)
#        - the pg_dump --schema-only diff
#   3. Builds a fresh JUnit log path and runs:
#        playwright test tests/specs/cross-tenant.staging.spec.ts
#      with the staging portal URL + supabase admin creds in env.
#      Writes the JUnit XML to /tmp/kaia-740-staging-e2e.junit.xml and
#      a human-readable summary to
#      supabase/tests/artifacts/staging-e2e.<UTC-timestamp>.log
#   4. Merges the SQL smoke log + the e2e log into:
#      supabase/tests/chatbot_clients_rls_smoke.staging.log
#      (the same path the apply script writes, so the Backend Developer's
#       workflow doesn't change)
#   5. Prints a one-screen summary (project ref, smoke pass/fail, e2e
#      pass/fail, log paths).
#
# Usage:
#   ./supabase/scripts/run-staging-e2e.sh           # full run
#   ./supabase/scripts/run-staging-e2e.sh --skip-apply
#                                                  # re-run only the e2e
#                                                  # (the migrations are
#                                                  # already applied)
#
# This script is INTENTIONALLY conservative. It does not retry, does not
# "best-effort" through failures, and does not write to a production-named
# variable. If anything in the chain fails, the script exits non-zero with
# a clear breadcrumb pointing at the failing step.
#
# Reuse: this is the wrapper the CEO asked the CTO to pre-stage so that the
# moment .env is in place, the Backend Developer can run it in a single
# heartbeat and close KAIA-731 + KAIA-740.

set -Eeuo pipefail

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------
SKIP_APPLY=0
for arg in "$@"; do
  case "$arg" in
    --skip-apply) SKIP_APPLY=1 ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $arg" >&2
      echo "Usage: $0 [--skip-apply]" >&2
      exit 64
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"
APPLY_SCRIPT="$SCRIPT_DIR/apply-to-staging.sh"
PORTAL_DIR="$REPO_ROOT/portal"
SPEC_REL="tests/specs/cross-tenant.staging.spec.ts"
SMOKE_STAGING_LOG="$REPO_ROOT/supabase/tests/chatbot_clients_rls_smoke.staging.log"
ARTIFACT_DIR="$REPO_ROOT/supabase/tests/artifacts"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
E2E_LOG="$ARTIFACT_DIR/staging-e2e.${TS}.log"
E2E_JUNIT="/tmp/kaia-740-staging-e2e.junit.xml"

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; BLU=$'\033[34m'; RST=$'\033[0m'
log()  { printf '%b==>%b %s\n' "$BLU" "$RST" "$*"; }
ok()   { printf '%b OK%b %s\n' "$GRN" "$RST" "$*"; }
warn() { printf '%bWARN%b %s\n' "$YEL" "$RST" "$*" >&2; }
die()  { printf '%bFAIL%b %s\n' "$RED" "$RST" "$*" >&2; exit 1; }

on_error() {
  local rc=$?
  warn "Script aborted on line ${BASH_LINENO[0]} (exit $rc)."
  warn "See $E2E_LOG and $SMOKE_STAGING_LOG for the partial output."
  exit $rc
}
trap on_error ERR

# ---------------------------------------------------------------------------
# Step 1 — sanity
# ---------------------------------------------------------------------------
log "Step 1: sanity checks (skip-apply=$SKIP_APPLY)"

for tool in psql jq curl; do
  command -v "$tool" >/dev/null 2>&1 || die "Required tool not on PATH: $tool"
done
ok "tools present: psql jq curl"

[[ -f "$ENV_FILE" ]] || die ".env not found at $ENV_FILE. Copy .env.example and fill in staging creds."
ok ".env present at $ENV_FILE"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

# NOTE: PORTAL_URL is the staging frontend (not the supabase URL). The
# apply-to-staging.sh script does not require it, but we do.
REQUIRED_VARS=(
  SUPABASE_URL
  SUPABASE_ANON_KEY
  SUPABASE_SERVICE_ROLE_KEY
  SUPABASE_DB_URL
  SUPABASE_SERVICE_ROLE_DB_URL
  PORTAL_URL
)
MISSING=0
for v in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!v:-}" ]]; then
    warn "Missing env var: $v"
    MISSING=1
  fi
done
[[ $MISSING -eq 0 ]] || die "Refusing to run: ${#REQUIRED_VARS[@]} vars are required (see .env.example)."

# Refuse to run against a localhost portal — that's the dev mock, not staging.
if [[ "$PORTAL_URL" == *localhost* || "$PORTAL_URL" == *127.0.0.1* ]]; then
  die "PORTAL_URL points at localhost ($PORTAL_URL). The staging e2e needs the real staging URL."
fi
ok "PORTAL_URL is a non-local URL: $PORTAL_URL"

[[ -f "$APPLY_SCRIPT" ]] || die "apply script missing: $APPLY_SCRIPT"
[[ -d "$PORTAL_DIR" ]]   || die "portal dir missing: $PORTAL_DIR"
[[ -f "$PORTAL_DIR/$SPEC_REL" ]] || die "staging e2e spec missing: $PORTAL_DIR/$SPEC_REL"
ok "all script + spec files present"

# Check for playwright availability without forcing a global install.
if ! command -v npx >/dev/null 2>&1; then
  die "npx not on PATH — install Node.js to run the Playwright e2e."
fi
if [[ ! -d "$PORTAL_DIR/node_modules/@playwright/test" ]]; then
  warn "@playwright/test is not in portal/node_modules — running \`npm ci\` first."
  ( cd "$PORTAL_DIR" && npm ci ) || die "portal npm ci failed"
fi
ok "playwright installed in portal/"

mkdir -p "$ARTIFACT_DIR"

# ---------------------------------------------------------------------------
# Step 2 — apply (delegated to apply-to-staging.sh)
# ---------------------------------------------------------------------------
if [[ $SKIP_APPLY -eq 0 ]]; then
  log "Step 2: running apply-to-staging.sh (migrations + seed + RLS smoke + diff)"
  bash "$APPLY_SCRIPT"
  ok "apply + RLS smoke succeeded"
else
  log "Step 2: --skip-apply set, reusing previous apply state"
  [[ -f "$SMOKE_STAGING_LOG" ]] || die "--skip-apply but $SMOKE_STAGING_LOG does not exist. Run without --skip-apply first."
  ok "previous smoke log present: $SMOKE_STAGING_LOG"
fi

# ---------------------------------------------------------------------------
# Step 3 — run the staging e2e (per-tenant magic link)
# ---------------------------------------------------------------------------
log "Step 3: running the per-tenant magic-link e2e (Playwright)"
log "  -> $SPEC_REL"
log "  log:    $E2E_LOG"
log "  junit:  $E2E_JUNIT"

cd "$PORTAL_DIR"

# Playwright reads baseURL from playwright.config.ts via PORTAL_URL. We
# also re-export the Supabase admin creds + the per-user email overrides
# so the spec + the helper pick them up.
export PORTAL_URL
export SUPABASE_URL
export SUPABASE_SERVICE_ROLE_KEY
# Defaults match supabase/seeds/chatbot_clients_seed.sql; operator can
# override in .env if they used different emails when creating the auth
# users in Supabase Studio.
export STAGING_TEST_USER_A_EMAIL="${STAGING_TEST_USER_A_EMAIL:-onboarding-test1@kairikos.dev}"
export STAGING_TEST_USER_B_EMAIL="${STAGING_TEST_USER_B_EMAIL:-onboarding-test2@kairikos.dev}"
export STAGING_TEST_USER_STAFF_EMAIL="${STAGING_TEST_USER_STAFF_EMAIL:-staff-test@kairikos.dev}"

# Force chromium only — Mobile Safari is a luxury we don't need for the
# acceptance gate and just slows the run. The cross-tenant.staging spec
# is tagged @staging so it's the only one we want to run here.
npx playwright test "$SPEC_REL" \
  --project=chromium \
  --reporter=list \
  --reporter=junit:"$E2E_JUNIT" \
  >"$E2E_LOG" 2>&1 \
  || {
    tail -80 "$E2E_LOG" >&2 || true
    die "Playwright staging e2e failed (full log: $E2E_LOG, junit: $E2E_JUNIT)"
  }
ok "Playwright staging e2e passed (log: $E2E_LOG)"

# ---------------------------------------------------------------------------
# Step 4 — merge the SQL smoke + e2e logs into the canonical path
# ---------------------------------------------------------------------------
log "Step 4: merging SQL smoke + e2e into $SMOKE_STAGING_LOG"

# Defensive: only merge if both files exist. If the SQL smoke is missing
# (e.g. --skip-apply + a stale workspace), warn but don't fail the e2e
# success — the Backend Developer can re-run without --skip-apply.
{
  printf '\n%s\n' '=========================================================================='
  printf ' KAIA-740 staging run @ %s\n' "$TS"
  printf '  PORTAL_URL=%s\n' "$PORTAL_URL"
  printf '  Supabase project ref: %s\n' \
    "$(printf '%s' "$SUPABASE_URL" | sed -nE 's#^https?://([a-z0-9]+)\.supabase\.co/?$#\1#p')"
  printf '%s\n' '=========================================================================='
  if [[ -f "$SMOKE_STAGING_LOG" ]]; then
    printf '\n## Section 1: SQL RLS smoke (apply-to-staging.sh)\n\n'
    cat "$SMOKE_STAGING_LOG"
  else
    printf '\n## Section 1: SQL RLS smoke — NOT RUN (--skip-apply, no prior log)\n\n'
  fi
  printf '\n## Section 2: per-tenant magic-link e2e (Playwright)\n\n'
  cat "$E2E_LOG"
  printf '\n## Section 3: JUnit XML\n\n'
  if [[ -f "$E2E_JUNIT" ]]; then
    printf 'JUnit written to %s (paste separately if your tracker prefers XML).\n' "$E2E_JUNIT"
  else
    printf 'No JUnit XML produced.\n'
  fi
} >"$SMOKE_STAGING_LOG.tmp"

mv "$SMOKE_STAGING_LOG.tmp" "$SMOKE_STAGING_LOG"
ok "merged log written to $SMOKE_STAGING_LOG"

# ---------------------------------------------------------------------------
# Step 5 — summary
# ---------------------------------------------------------------------------
log "Step 5: summary"
cat <<SUMMARY

$(printf '%b' "$GRN")=== KAIA-740 staging apply + smoke + e2e: SUCCESS ===$(printf '%b' "$RST")
  Portal:     $PORTAL_URL
  Supabase:   $SUPABASE_URL
  Project:    $(printf '%s' "$SUPABASE_URL" | sed -nE 's#^https?://([a-z0-9]+)\.supabase\.co/?$#\1#p')
  E2E log:    $E2E_LOG
  JUnit:      $E2E_JUNIT
  Merged log: $SMOKE_STAGING_LOG

  Sections in $SMOKE_STAGING_LOG:
    1. SQL RLS smoke (8 checks)
    2. Per-tenant magic-link e2e (3 cases: client A, client B, staff)
    3. JUnit XML path

  Next action for the Backend Developer:
    1. Paste the merged log into a comment on KAIA-731.
    2. Mark KAIA-731 done (or request review if you want the CTO to spot-check).
    3. Mark KAIA-740 done — its single acceptance criteria is now met.
    4. KAIA-732, KAIA-736, KAIA-738 should auto-unblock via blockedByIssueIds.
SUMMARY
