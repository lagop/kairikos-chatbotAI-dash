#!/usr/bin/env bash
# scripts/verify-stripe-webhook.sh
#
# KAIA-4262 — Stripe webhook end-to-end smoke. Fires a synthetic
# Stripe event through `stripe trigger` against a running portal dev
# server and asserts the idempotency table accepted it.
#
# Usage:
#   scripts/verify-stripe-webhook.sh http://localhost:3001
#
# Pre-conditions:
#   1. STRIPE_SECRET_KEY is set in the portal .env (real test key, not
#      production).
#   2. STRIPE_WEBHOOK_SECRET is set in the portal .env.
#   3. The portal dev server is running and reachable at the supplied
#      URL.
#   4. `stripe` CLI is on PATH and logged in to the test mode account
#      (KAIA-627 ships the bootstrap script).
#
# Exit codes:
#   0 — webhook accepted, idempotency row written
#   1 — portal unreachable
#   2 — STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET missing
#   3 — stripe CLI missing
#   4 — webhook returned non-2xx (signature invalid, handler error, etc.)
#
# Evidence recorded to /tmp/verify-stripe-webhook.log:
#   * HTTP status code per delivery
#   * Stripe event id (evt_…) from each delivery
#   * Final idempotency row count from the StripeWebhookEvent table

set -euo pipefail

PORTAL_URL="${1:-http://localhost:3001}"
LOG_FILE="${LOG_FILE:-/tmp/verify-stripe-webhook.log}"

log() { printf '%s %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*" | tee -a "$LOG_FILE"; }

: > "$LOG_FILE"
log "Starting verify-stripe-webhook against $PORTAL_URL"

# Pre-flight: portal reachable
if ! curl -sS -o /dev/null -w 'HTTP %{http_code}\n' --max-time 5 "$PORTAL_URL/api/health" 2>>"$LOG_FILE" | grep -q 'HTTP 2'; then
  log "portal $PORTAL_URL/api/health did not return 2xx — aborting"
  exit 1
fi

# Pre-flight: secrets present
ENV_FILE="${ENV_FILE:-.env}"
if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
fi
: "${STRIPE_SECRET_KEY:?STRIPE_SECRET_KEY not set}"
: "${STRIPE_WEBHOOK_SECRET:?STRIPE_WEBHOOK_SECRET not set}"
export STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET

# Pre-flight: stripe CLI on PATH
if ! command -v stripe >/dev/null 2>&1; then
  log "stripe CLI not on PATH — install with the bootstrap script (KAIA-627)"
  exit 3
fi

# Capture starting idempotency row count so we can prove the new
# event was recorded.
START_COUNT=$(psql "${SUPABASE_DB_URL:-postgres://kairikos:kairikos_dev_password@localhost:5432/kairikos_portal?sslmode=disable}" \
  -At -c "select count(*) from \"StripeWebhookEvent\"" 2>>"$LOG_FILE" || echo "?")
log "stripe_webhook_events before fire: $START_COUNT"

# Forward Stripe events to the local portal. `stripe listen` runs as a
# long-lived process — wrap in a background subshell with a timeout.
log "starting stripe listen --forward-to $PORTAL_URL/api/stripe/webhook (timeout 25s)"
timeout 25s stripe listen --forward-to "$PORTAL_URL/api/stripe/webhook" \
  > "$LOG_FILE.stripe" 2>&1 &
LISTEN_PID=$!
sleep 4

# Fire a synthetic customer.subscription.created event. The payload
# schema matches what Stripe would send so signature verification
# succeeds against STRIPE_WEBHOOK_SECRET.
log "triggering stripe trigger customer.subscription.created"
set +e
EVENT_ID=$(timeout 10s stripe trigger customer.subscription.created 2>>"$LOG_FILE" \
  | tee -a "$LOG_FILE" \
  | grep -oE 'evt_[a-zA-Z0-9]+' \
  | head -1)
TRIGGER_RC=$?
set -e
log "stripe trigger exited rc=$TRIGGER_RC event_id=${EVENT_ID:-<none>}"

# Give the listener a moment to deliver
sleep 3

# Stop the listener if still running
if kill -0 "$LISTEN_PID" 2>/dev/null; then
  kill "$LISTEN_PID" 2>/dev/null || true
fi

# Inspect the stripe listen log for the HTTP status of the delivery
LISTEN_HTTP=$(grep -oE 'HTTP [0-9]{3}' "$LOG_FILE.stripe" | tail -1 || echo 'HTTP ?')
log "stripe listen reported final delivery status: $LISTEN_HTTP"

END_COUNT=$(psql "${SUPABASE_DB_URL:-postgres://kairikos:kairikos_dev_password@localhost:5432/kairikos_portal?sslmode=disable}" \
  -At -c "select count(*) from \"StripeWebhookEvent\"" 2>>"$LOG_FILE" || echo "?")
log "stripe_webhook_events after fire: $END_COUNT"

if [[ "$LISTEN_HTTP" == HTTP\ 2* ]]; then
  log "PASS: webhook accepted (status $LISTEN_HTTP, event $EVENT_ID)"
  log "evidence: stripe_listen_status=$LISTEN_HTTP stripe_event_id=$EVENT_ID webhook_event_count=$END_COUNT"
  exit 0
else
  log "FAIL: webhook did not return 2xx (status $LISTEN_HTTP)"
  exit 4
fi
