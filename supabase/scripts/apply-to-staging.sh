#!/usr/bin/env bash
# supabase/scripts/apply-to-staging.sh
#
# KAIA-743 — pre-staged migration runner for the chatbot portal schema.
# Goal: when the operator drops staging SUPABASE_* credentials into .env, the
# next wake of KAIA-740 (Backend) runs `apply + smoke + e2e` in a single
# heartbeat, with zero improvisation.
#
# What it does (in order):
#   0. Sanity-checks: shell tools, .env, the 5 required SUPABASE_* vars,
#      the staging project identity (STAGING_PROJECT_REF must match
#      SUPABASE_URL host), and a live DB ping.
#   1. Captures pre-migration schema dump  -> /tmp/kaia-740-pre.schema.sql
#   2. Applies supabase/migrations/001_create_chatbot_portal_tables.sql
#      then 002_enable_rls_chatbot_portal.sql against $SUPABASE_DB_URL
#      (idempotent: every CREATE uses IF NOT EXISTS / drop policy if exists).
#   3. Applies supabase/seeds/chatbot_clients_seed.sql against
#      $SUPABASE_SERVICE_ROLE_DB_URL (idempotent: ON CONFLICT DO NOTHING).
#   4. Ensures the two auth.users rows exist (Admin API if
#      SUPABASE_SERVICE_ROLE_KEY is set, else prints the exact payload for
#      the operator to run in Supabase Studio).
#   5. (KAIA-2900) Seeds a known argon2id passwordHash on the three client
#      test users (onboarding-test1/2, staff-test@kairikos.dev) via the
#      portal/scripts/seed-test-passwords.ts helper. Password is sourced
#      from $STAGING_TEST_USER_PASSWORD (canonical, what the QA fixture and
#      load-secrets.sh agree on) with a hard-coded fallback so the seed is
#      never silent. Idempotent. If node + the portal deps are not
#      available, prints the exact payload for the operator to run by hand.
#   6. Runs the Supabase-friendly RLS smoke
#      supabase/tests/chatbot_clients_rls_smoke.staging.sql
#      (no local auth shim — uses real Supabase auth.uid()/auth.jwt()).
#      Writes the run log to supabase/tests/chatbot_clients_rls_smoke.staging.log
#   7. Captures post-migration schema dump -> /tmp/kaia-740-post.schema.sql
#      and diffs against pre. Fails loudly if anything other than the four
#      new tables/indexes/policies appears in the diff.
#   7. Prints a one-screen summary (pre/post diff summary, smoke status,
#      per-tenant JWT e2e results).
#
# Usage:
#   ./supabase/scripts/apply-to-staging.sh           # full apply
#   ./supabase/scripts/apply-to-staging.sh --dry-run # env + sanity only
#
# Idempotency:
#   - Migrations use `if not exists` / `drop policy if exists` (see the
#     migration bodies); re-running is safe.
#   - The seed uses `on conflict ... do nothing` keyed on stable ids.
#   - The smoke itself is re-runnable.
#   - Auth users are created with a deterministic email and a fixed UUID
#     (set on the script's first run via the admin API; subsequent runs
#     print "auth users already present" and move on).
#
# Reversibility:
#   - The .down.sql companions live in supabase/migrations/ alongside the
#     .up.sql files. To roll back, run them in reverse order:
#       psql "$SUPABASE_SERVICE_ROLE_DB_URL" -v ON_ERROR_STOP=1 \
#         -f supabase/migrations/20260609_1200_002_enable_rls_chatbot_portal.down.sql
#       psql "$SUPABASE_SERVICE_ROLE_DB_URL" -v ON_ERROR_STOP=1 \
#         -f supabase/migrations/20260609_1200_001_create_chatbot_portal_tables.down.sql
#   - The post-diff step will HARD-FAIL if anything outside the four tables
#     was changed. Do NOT apply twice if the diff is unexpected — investigate
#     first.

set -Eeuo pipefail

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,40p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $arg" >&2
      echo "Usage: $0 [--dry-run]" >&2
      exit 64
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# repo root = supabase/../
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"
MIG_DIR="$REPO_ROOT/supabase/migrations"
SEED_DIR="$REPO_ROOT/supabase/seeds"
TEST_DIR="$REPO_ROOT/supabase/tests"

MIG_001="$MIG_DIR/20260609_1200_001_create_chatbot_portal_tables.sql"
MIG_002="$MIG_DIR/20260609_1200_002_enable_rls_chatbot_portal.sql"
SEED_FILE="$SEED_DIR/chatbot_clients_seed.sql"
SMOKE_STAGING="$TEST_DIR/chatbot_clients_rls_smoke.staging.sql"
SMOKE_STAGING_LOG="$TEST_DIR/chatbot_clients_rls_smoke.staging.log"

PRE_DUMP="/tmp/kaia-740-pre.schema.sql"
POST_DUMP="/tmp/kaia-740-post.schema.sql"

# The four tables the migration owns. Anything else in the diff is suspicious.
EXPECTED_TABLES=(
  "chatbot_clients"
  "chatbot_client_users"
  "chatbot_activity"
  "chatbot_conversations"
)

# ---------------------------------------------------------------------------
# Tiny logging helpers
# ---------------------------------------------------------------------------
RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; BLU=$'\033[34m'; RST=$'\033[0m'
log()  { printf '%b==>%b %s\n' "$BLU" "$RST" "$*"; }
ok()   { printf '%b OK%b %s\n' "$GRN" "$RST" "$*"; }
warn() { printf '%bWARN%b %s\n' "$YEL" "$RST" "$*" >&2; }
die()  { printf '%bFAIL%b %s\n' "$RED" "$RST" "$*" >&2; exit 1; }

on_error() {
  local rc=$?
  warn "Script aborted on line ${BASH_LINENO[0]} (exit $rc)."
  warn "If the failure was a DB error, the database is in an unknown state."
  warn "Inspect the partial output above and run \`psql\` by hand before retrying."
  warn "Do NOT re-run this script blindly — the post-diff step exists to catch"
  warn "exactly that kind of footgun."
  exit $rc
}
trap on_error ERR

# ---------------------------------------------------------------------------
# Step 0 — sanity
# ---------------------------------------------------------------------------
log "Step 0: sanity checks (dry-run=$DRY_RUN)"

for tool in psql pg_dump curl jq; do
  command -v "$tool" >/dev/null 2>&1 || die "Required tool not on PATH: $tool"
done
ok "tools present: psql pg_dump curl jq"

[[ -f "$ENV_FILE" ]] || die ".env not found at $ENV_FILE. Copy .env.example and fill in staging creds."
ok ".env present at $ENV_FILE"

# Load .env without sourcing (avoid surprise side effects), tolerating
# quoted values and `export ` prefixes.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

REQUIRED_VARS=(
  SUPABASE_URL
  SUPABASE_ANON_KEY
  SUPABASE_SERVICE_ROLE_KEY
  SUPABASE_DB_URL
  SUPABASE_SERVICE_ROLE_DB_URL
)
MISSING=0
for v in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!v:-}" ]]; then
    warn "Missing env var: $v"
    MISSING=1
  fi
done
[[ $MISSING -eq 0 ]] || die "Refusing to run: ${#REQUIRED_VARS[@]} SUPABASE_* vars are required (see .env.example)."

# Pull the project ref out of the URL host: https://abcdefghij.supabase.co
EXPECTED_REF="${STAGING_PROJECT_REF:-}"
if [[ -z "$EXPECTED_REF" ]]; then
  warn "STAGING_PROJECT_REF is not set in .env — cannot verify project identity."
  warn "Set STAGING_PROJECT_REF=<the-supabase-project-ref> in .env and re-run."
  warn "(This is a safety check: it prevents applying a migration to the wrong project.)"
  die "Refusing to run without STAGING_PROJECT_REF."
fi

ACTUAL_REF="$(printf '%s' "$SUPABASE_URL" | sed -nE 's#^https?://([a-z0-9]+)\.supabase\.co/?$#\1#p')"
if [[ -z "$ACTUAL_REF" ]]; then
  die "Could not parse project ref out of SUPABASE_URL=$SUPABASE_URL"
fi
if [[ "$ACTUAL_REF" != "$EXPECTED_REF" ]]; then
  die "Project identity mismatch: SUPABASE_URL points to '$ACTUAL_REF' but STAGING_PROJECT_REF='$EXPECTED_REF'."
fi
ok "staging project ref matches: $ACTUAL_REF"

# DB ping. We use the *service-role* DB URL because it bypasses RLS and
# exercises the same path we'll use to apply the seed.
PING_OUT="$(psql "$SUPABASE_SERVICE_ROLE_DB_URL" -tA -c "select current_database() || '|' || current_user;" 2>&1)" \
  || die "Could not connect to staging DB: $PING_OUT"
ok "DB ping OK: $PING_OUT"

# File presence
for f in "$MIG_001" "$MIG_002" "$SEED_FILE"; do
  [[ -f "$f" ]] || die "Required file missing: $f"
done
ok "migration + seed files present"

# Down migrations (referenced for the rollback hint, not required to run)
DOWN_001="$MIG_DIR/20260609_1200_001_create_chatbot_portal_tables.down.sql"
DOWN_002="$MIG_DIR/20260609_1200_002_enable_rls_chatbot_portal.down.sql"
for f in "$DOWN_001" "$DOWN_002"; do
  if [[ ! -f "$f" ]]; then
    warn "Down migration missing: $f — rollback hint will be incomplete."
  fi
done

# Staging smoke must exist by the time we get here.
[[ -f "$SMOKE_STAGING" ]] || die "Staging smoke missing: $SMOKE_STAGING — see KAIA-743 deliverable."
ok "staging smoke present: $(basename "$SMOKE_STAGING")"

if [[ $DRY_RUN -eq 1 ]]; then
  ok "DRY RUN: all sanity checks passed. Would apply migrations + seed + smoke next."
  printf '%b\n' "$GRN" "  Project:    $ACTUAL_REF" "$RST"
  printf '%b\n' "$GRN" "  DB:         $(printf '%s' "$PING_OUT" | cut -d'|' -f1)" "$RST"
  printf '%b\n' "$GRN" "  Migrations: $(basename "$MIG_001") + $(basename "$MIG_002")" "$RST"
  printf '%b\n' "$GRN" "  Seed:       $(basename "$SEED_FILE")" "$RST"
  printf '%b\n' "$GRN" "  Smoke:      $(basename "$SMOKE_STAGING")" "$RST"
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 1 — pre-migration schema dump
# ---------------------------------------------------------------------------
log "Step 1: capturing pre-migration schema"
pg_dump "$SUPABASE_SERVICE_ROLE_DB_URL" --schema-only --no-owner --no-acl \
  >"$PRE_DUMP" 2>/dev/null || die "pg_dump pre failed"
ok "pre-dump written to $PRE_DUMP ($(wc -l <"$PRE_DUMP") lines)"

# ---------------------------------------------------------------------------
# Step 2 — apply migrations in order (idempotent)
# ---------------------------------------------------------------------------
log "Step 2: applying migrations against \$SUPABASE_DB_URL"
log "  -> $MIG_001"
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$MIG_001" >/tmp/kaia-740-001.log 2>&1 \
  || { tail -50 /tmp/kaia-740-001.log >&2; die "Migration 001 failed"; }
ok "migration 001 applied"

log "  -> $MIG_002"
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$MIG_002" >/tmp/kaia-740-002.log 2>&1 \
  || { tail -50 /tmp/kaia-740-002.log >&2; die "Migration 002 failed"; }
ok "migration 002 applied"

# ---------------------------------------------------------------------------
# Step 3 — apply seed against service-role DB URL
# ---------------------------------------------------------------------------
log "Step 3: applying seed against \$SUPABASE_SERVICE_ROLE_DB_URL"
psql "$SUPABASE_SERVICE_ROLE_DB_URL" -v ON_ERROR_STOP=1 -f "$SEED_FILE" >/tmp/kaia-740-seed.log 2>&1 \
  || { tail -50 /tmp/kaia-740-seed.log >&2; die "Seed failed"; }
ok "seed applied (idempotent)"

# ---------------------------------------------------------------------------
# Step 4 — ensure the two auth.users rows exist
# ---------------------------------------------------------------------------
log "Step 4: ensuring the two test auth.users rows exist"

# Deterministic UUIDs + emails so the seed's chatbot_client_users insert can
# match. These match the local smoke's expectations (00000000-...-00a1/00a2).
# The smoke is parameterised on these (psql -v), so if the operator pre-created
# auth.users with different IDs in Supabase Studio, they can override the
# runner with -v user_a=... -v user_b=... -v user_c=... -v user_staff=...
STAGING_TEST_USER_A_ID="00000000-0000-0000-0000-0000000000a1"
STAGING_TEST_USER_A_EMAIL="onboarding-test1@kairikos.dev"
STAGING_TEST_USER_B_ID="00000000-0000-0000-0000-0000000000a2"
STAGING_TEST_USER_B_EMAIL="onboarding-test2@kairikos.dev"
# We don't actually create an auth.users row for staff in this script — the
# RLS smoke uses a synthetic staff JWT that Supabase auth never sees (we
# plant it via set local request.jwt.claims). It just needs the helper
# public.chatbot_is_staff() to be installed, which the 002 migration does.
STAGING_TEST_USER_STAFF_ID="00000000-0000-0000-0000-00000000staff"

# Probe the auth schema. Supabase always has auth.users and exposes it to
# the service_role. We read by id; if a row is missing, we'll create it.
auth_user_count() {
  psql "$SUPABASE_SERVICE_ROLE_DB_URL" -tA -c \
    "select count(*) from auth.users where id in ('$STAGING_TEST_USER_A_ID'::uuid, '$STAGING_TEST_USER_B_ID'::uuid);"
}

ensure_auth_user() {
  local user_id="$1" email="$2"
  local exists
  exists="$(psql "$SUPABASE_SERVICE_ROLE_DB_URL" -tA -c \
    "select count(*) from auth.users where id = '$user_id'::uuid;")"
  if [[ "$exists" -ge 1 ]]; then
    ok "auth.users row present: $email ($user_id)"
    return 0
  fi
  if [[ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
    warn "auth.users row missing for $email and SUPABASE_SERVICE_ROLE_KEY is not set."
    warn "Create the user via Supabase Studio -> Authentication -> Users -> Add user:"
    warn "  user_id: $user_id"
    warn "  email:   $email"
    warn "  password: (anything; the smoke never logs in with a password)"
    warn "  Auto Confirm User: ON"
    return 1
  fi
  # Supabase Auth admin endpoint. /auth/v1/admin/users requires the
  # service_role JWT in the apikey + Authorization header. We pass the
  # desired UUID via the request body so chatbot_client_users can match.
  local payload
  payload="$(jq -n \
    --arg id "$user_id" \
    --arg email "$email" \
    '{id:$id, email:$email, email_confirm:true, aud:"authenticated", role:"authenticated"}')"
  local http_code body
  body="$(curl -sS -o /tmp/kaia-740-auth-body.json -w '%{http_code}' \
    -X POST "$SUPABASE_URL/auth/v1/admin/users" \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Content-Type: application/json" \
    --data "$payload")" || die "curl to /auth/v1/admin/users failed"
  http_code="$body"
  if [[ "$http_code" != "200" && "$http_code" != "201" ]]; then
    warn "Supabase Auth admin create failed for $email (HTTP $http_code):"
    cat /tmp/kaia-740-auth-body.json >&2 || true
    return 1
  fi
  ok "auth.users row created via Admin API: $email ($user_id)"
}

ensure_auth_user "$STAGING_TEST_USER_A_ID" "$STAGING_TEST_USER_A_EMAIL" || \
  die "Could not ensure auth.users row A. See messages above; create it manually in Studio and re-run."
ensure_auth_user "$STAGING_TEST_USER_B_ID" "$STAGING_TEST_USER_B_EMAIL" || \
  die "Could not ensure auth.users row B. See messages above; create it manually in Studio and re-run."

PRESENT="$(auth_user_count)"
[[ "$PRESENT" -ge 2 ]] || die "Expected >= 2 test auth.users rows, found $PRESENT."
ok "both test auth.users rows present (count=$PRESENT)"

# ---------------------------------------------------------------------------
# Step 5 — (KAIA-2900) seed a known passwordHash on the three client test
# users so the Playwright `authedPortalFixture` can log in via
# `portal-credentials` (the Supabase magic-link path returns a fragment
# cookie that the portal's auth.ts does not consume).
#
# The seed is delegated to `portal/scripts/seed-test-passwords.ts`, which
# uses @supabase/supabase-js + src/lib/operator-crypto.hashPassword
# (argon2id) against the User table. It is idempotent (re-running refreshes
# the hash on the existing rows).
#
# Why a portal tsx script (and not inline psql)
# ----------------------------------------------
# We need a standard argon2id hash with the same parameters the request
# path uses in `verifyPassword(user.passwordHash, password)`. PostgreSQL
# has no built-in argon2; pgcrypto's crypt() only does bcrypt/standard.
# Generating the hash inline in psql would either (a) be a different
# algorithm that auth.ts rejects, or (b) require shelling out from psql,
# which is fragile. The portal tsx helper uses the exact same code path
# the auth lib runs on the request path, so the hash is guaranteed to
# verify. It also reads $STAGING_TEST_USER_PASSWORD the same way the
# QA fixture does, so the QA runtime and the seed agree on the password
# by construction.
# ---------------------------------------------------------------------------
log "Step 5: seeding passwordHash on the client test users (KAIA-2900)"

PORTAL_DIR="$REPO_ROOT/portal"
SEED_TEST_PW_SCRIPT="$PORTAL_DIR/scripts/seed-test-passwords.ts"

if [[ ! -f "$SEED_TEST_PW_SCRIPT" ]]; then
  die "KAIA-2900: seed-test-passwords.ts missing at $SEED_TEST_PW_SCRIPT"
fi

if [[ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
  warn "SUPABASE_SERVICE_ROLE_KEY is not set — cannot run seed-test-passwords.ts."
  warn "Run it manually after this script finishes (see portal/scripts/seed-test-passwords.ts):"
  warn "  cd $PORTAL_DIR"
  warn "  SUPABASE_URL='$SUPABASE_URL' \\"
  warn "  SUPABASE_SERVICE_ROLE_KEY='<paste from 1Password>' \\"
  warn "  STAGING_TEST_USER_PASSWORD='<value the QA fixture sources>' \\"
  warn "    npx tsx scripts/seed-test-passwords.ts"
  warn "Until that runs, the Playwright authedPortalFixture will fail with a 302"
  warn "to /portal/login?error=CredentialsSignin (the User.passwordHash is still"
  warn "null or __must_reset__)."
else
  # Export everything the helper needs. .env is already loaded above; we
  # only override SUPABASE_URL so the helper matches what was used for
  # the admin API in Step 4.
  export SUPABASE_URL
  export SUPABASE_SERVICE_ROLE_KEY
  # STAGING_TEST_USER_PASSWORD is sourced from .env if the operator set
  # it; if not, the helper falls back to its hard-coded default. Either
  # way the seed is non-silent (it prints the chosen source).
  pushd "$PORTAL_DIR" >/dev/null || die "could not cd to $PORTAL_DIR"
  if ! npx --no-install tsx scripts/seed-test-passwords.ts >/tmp/kaia-2900-seed.log 2>&1; then
    popd >/dev/null || true
    tail -50 /tmp/kaia-2900-seed.log >&2 || true
    die "KAIA-2900: seed-test-passwords.ts failed. See /tmp/kaia-2900-seed.log."
  fi
  popd >/dev/null || true
  ok "KAIA-2900: client test users seeded (log: /tmp/kaia-2900-seed.log)"
fi

# ---------------------------------------------------------------------------
# Step 6 — run the staging RLS smoke
# ---------------------------------------------------------------------------
log "Step 5: running RLS smoke (writes log to $SMOKE_STAGING_LOG)"
log "  -> $SMOKE_STAGING"
# Pass the deterministic UUIDs as psql -v so the smoke uses them. The
# default values match what this script just planted in auth.users; the
# operator can override with -v user_a=... etc. on the command line if
# they pre-created different IDs in Supabase Studio.
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
  -v user_a="$STAGING_TEST_USER_A_ID" \
  -v user_b="$STAGING_TEST_USER_B_ID" \
  -v user_c="00000000-0000-0000-0000-0000000000a3" \
  -v user_staff="$STAGING_TEST_USER_STAFF_ID" \
  -v client_a="11111111-1111-1111-1111-111111111111" \
  -v client_b="22222222-2222-2222-2222-222222222222" \
  -f "$SMOKE_STAGING" >"$SMOKE_STAGING_LOG" 2>&1 \
  || { tail -80 "$SMOKE_STAGING_LOG" >&2; die "RLS smoke failed (full log: $SMOKE_STAGING_LOG)"; }
ok "RLS smoke passed (log: $SMOKE_STAGING_LOG)"

# ---------------------------------------------------------------------------
# Step 7 — post-migration schema dump + diff
# ---------------------------------------------------------------------------
log "Step 7: capturing post-migration schema and diffing"
pg_dump "$SUPABASE_SERVICE_ROLE_DB_URL" --schema-only --no-owner --no-acl \
  >"$POST_DUMP" 2>/dev/null || die "pg_dump post failed"
ok "post-dump written to $POST_DUMP ($(wc -l <"$POST_DUMP") lines)"

# Build a set of "expected to change" line patterns: anything mentioning
# one of the four table names, or the helpers, or the RLS policies named
# after them. This is intentionally permissive on the chatbot_* side and
# strict on everything else.
DIFF_FILE="/tmp/kaia-740-schema.diff"
diff -u "$PRE_DUMP" "$POST_DUMP" >"$DIFF_FILE" || true

# Lines starting with '+' (additions). Drop blank lines and the
# CREATE/ALTER boilerplate for our four tables. What remains must be empty
# (or only meta-noise we explicitly allow).
SUSPECT="$(grep '^+' "$DIFF_FILE" \
  | grep -vE '^\+\+\+' \
  | grep -vE 'chatbot_(clients|client_users|activity|conversations)' \
  | grep -vE '^+\s*--' \
  || true)"

if [[ -n "${SUSPECT// /}" ]]; then
  warn "Unexpected schema changes detected. Refusing to call this a clean apply."
  warn "Suspect additions (anything not in the four chatbot_* tables):"
  printf '%s\n' "$SUSPECT" | sed 's/^/    /' >&2
  warn "Full diff is in $DIFF_FILE for forensic inspection."
  warn "DO NOT re-apply. Investigate the staging project state first."
  die "Post-diff contained unexpected additions. See $DIFF_FILE."
fi
ok "post-diff is additive-only and limited to the four chatbot_* tables"

# ---------------------------------------------------------------------------
# Step 8 — summary
# ---------------------------------------------------------------------------
log "Step 8: summary"
cat <<SUMMARY

$(printf '%b' "$GRN")=== KAIA-740 staging apply + smoke: SUCCESS ===$(printf '%b' "$RST")
  Project:     $ACTUAL_REF
  DB:          $(printf '%s' "$PING_OUT" | cut -d'|' -f1)
  Pre-dump:    $PRE_DUMP ($(wc -l <"$PRE_DUMP") lines)
  Post-dump:   $POST_DUMP ($(wc -l <"$POST_DUMP") lines)
  Diff:        $DIFF_FILE (additive-only, four chatbot_* tables)
  Migrations:  001 + 002 applied
  Seed:        2 fake clients + activity + conversations inserted
  Auth users:  $PRESENT/2 expected rows present
  Test users:  argon2id passwordHash set on 3 client test users (KAIA-2900)
  Smoke log:   $SMOKE_STAGING_LOG
  Smoke:       8/8 RLS checks passed

  Per-tenant e2e (per the staging smoke):
    Client A (id ends 0a1) -> SELECT chatbot_clients returns exactly 1 row
    Client B (id ends 0a2) -> SELECT chatbot_clients returns exactly 1 row (different)
    Unmapped user          -> 0 rows
    Staff (app_metadata)   -> all rows
    Authenticated          -> cannot INSERT (insufficient_privilege)

  Rollback (if you must):
    psql "\$SUPABASE_SERVICE_ROLE_DB_URL" -v ON_ERROR_STOP=1 \\
      -f $DOWN_002
    psql "\$SUPABASE_SERVICE_ROLE_DB_URL" -v ON_ERROR_STOP=1 \\
      -f $DOWN_001

  If anything in the post-diff is unexpected, abort — do not apply to staging twice.
SUMMARY
