#!/usr/bin/env bash
# scripts/update-stripe-price-ids.sh
#
# KAIA-4262 — Update Product.stripe_price_id from environment variables.
#
# This script reads STRIPE_PRICE_ID_STARTER, STRIPE_PRICE_ID_PRO, and
# STRIPE_PRICE_ID_PREMIUM from the environment and updates the corresponding
# Product rows in Supabase. The env vars should be set from the Vercel
# project env (or sourced from a local .env file for local testing).
#
# Usage:
#   # From Vercel env (production/staging)
#   STRIPE_PRICE_ID_STARTER=price_xxx STRIPE_PRICE_ID_PRO=price_yyy \
#     STRIPE_PRICE_ID_PREMIUM=price_zzz ./scripts/update-stripe-price-ids.sh
#
#   # From local .env
#   source .env && ./scripts/update-stripe-price-ids.sh
#
# Pre-conditions:
#   1. SUPABASE_DB_URL is set (connection string for the target environment)
#   2. STRIPE_PRICE_ID_STARTER, STRIPE_PRICE_ID_PRO, STRIPE_PRICE_ID_PREMIUM
#      are set to real Stripe Price IDs (price_xxx format)
#   3. psql is on PATH
#
# Exit codes:
#   0 — all three tiers updated successfully
#   1 — missing environment variable
#   2 — database update failed

set -euo pipefail

log() { printf '%s %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"; }

# Load from .env if present (for local dev/testing)
ENV_FILE="${ENV_FILE:-.env}"
if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE" 2>/dev/null; set +a
fi

# Verify required env vars
: "${SUPABASE_DB_URL:?SUPABASE_DB_URL not set}"
: "${STRIPE_PRICE_ID_STARTER:?STRIPE_PRICE_ID_STARTER not set}"
: "${STRIPE_PRICE_ID_PRO:?STRIPE_PRICE_ID_PRO not set}"
: "${STRIPE_PRICE_ID_PREMIUM:?STRIPE_PRICE_ID_PREMIUM not set}"

log "Updating Product.stripe_price_id for all tiers"

# Validate price ID format (should start with price_)
for tier in starter pro premium; do
  var="STRIPE_PRICE_ID_$(echo "$tier" | tr '[:lower:]' '[:upper:]')"
  val="${!var}"
  if [[ ! "$val" =~ ^price_[a-zA-Z0-9]+$ ]]; then
    log "ERROR: $var='$val' does not look like a valid Stripe Price ID (expected price_xxx)"
    exit 1
  fi
  log "  $tier: $val"
done

# Execute the update in a transaction
UPDATE_SQL="
BEGIN;

UPDATE public.products
SET stripe_price_id = '${STRIPE_PRICE_ID_STARTER}'
WHERE tier = 'starter'
  AND stripe_price_id IS DISTINCT FROM '${STRIPE_PRICE_ID_STARTER}';

UPDATE public.products
SET stripe_price_id = '${STRIPE_PRICE_ID_PRO}'
WHERE tier = 'pro'
  AND stripe_price_id IS DISTINCT FROM '${STRIPE_PRICE_ID_PRO}';

UPDATE public.products
SET stripe_price_id = '${STRIPE_PRICE_ID_PREMIUM}'
WHERE tier = 'premium'
  AND stripe_price_id IS DISTINCT FROM '${STRIPE_PRICE_ID_PREMIUM}';

-- Verify the update
SELECT tier, stripe_price_id, name, price_cents FROM public.products WHERE tier IN ('starter', 'pro', 'premium');

COMMIT;
"

log "Running update transaction..."
RESULT=$(psql "$SUPABASE_DB_URL" -t -c "$UPDATE_SQL" 2>&1) || {
  log "ERROR: database update failed"
  log "$RESULT"
  exit 2
}

log "Update complete. Product table now contains:"
echo "$RESULT" | while read -r line; do
  log "  $line"
done

log "Done."
