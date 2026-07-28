#!/usr/bin/env bash
# scripts/create-stripe-products.sh
#
# KAIA-4262 / KAIA-5514 — Create the three Kairikos subscription Products
# in Stripe (one per tier) and emit their stripe_price_id (price_...) for
# downstream backfill.
#
# The script uses the Stripe REST API directly (curl + jq), so it does not
# require the stripe CLI or the Stripe SDK. The caller must supply a
# Stripe API key (sk_test_... or sk_live_...).
#
# Usage:
#   STRIPE_SECRET_KEY=sk_test_xxx ./scripts/create-stripe-products.sh
#
#   # or via the project load-secrets.sh (after the operator provisions
#   # the secret in GCP SM at kairikos-secrets/stripe-secret-key):
#   source scripts/load-secrets.sh
#   eval "$(./scripts/create-stripe-products.sh)"
#
# Pre-conditions:
#   1. STRIPE_SECRET_KEY is set in the environment
#   2. curl and jq are on PATH
#
# Idempotency:
#   The script first lists existing products whose metadata.kairikos_tier
#   is set. If a product already exists for a tier, the script reuses
#   its default price and skips the create. Otherwise it creates the
#   product + recurring EUR price.
#
# Output:
#   JSON map { starter: "price_xxx", pro: "price_yyy", premium: "price_zzz" }
#   printed to stdout on success. The values are also emitted as shell
#   exports so they can be `eval`'d by the caller:
#
#     eval "$(STRIPE_SECRET_KEY=sk_... ./scripts/create-stripe-products.sh)"
#     echo "$STRIPE_PRICE_ID_STARTER"
#
# Exit codes:
#   0 — all three products/prices created or already present
#   1 — missing environment variable or required tool
#   2 — Stripe API error
#   3 — partial success (some tiers created, some failed)

set -euo pipefail

log() { printf '%s %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*" >&2; }

: "${STRIPE_SECRET_KEY:?STRIPE_SECRET_KEY not set}"

command -v jq >/dev/null 2>&1 || { log "jq not found on PATH"; exit 1; }
command -v curl >/dev/null 2>&1 || { log "curl not found on PATH"; exit 1; }

STRIPE_API="${STRIPE_API:-https://api.stripe.com/v1}"
AUTH=(-H "Authorization: Bearer ${STRIPE_SECRET_KEY}")

# Tier definitions: tier name → EUR amount (cents)
declare -A PRICE_CENTS=(
  [starter]=9900
  [pro]=24900
  [premium]=49900
)
declare -A PRODUCT_NAME=(
  [starter]="Kairikos Starter"
  [pro]="Kairikos Pro"
  [premium]="Kairikos Premium"
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# stripe_get PATH — perform a GET against the Stripe API and emit the
# raw JSON body on stdout. Returns non-zero on 4xx/5xx so set -e catches it.
stripe_get() {
  local path="$1"
  local response
  response=$(curl --silent --show-error --fail-with-body \
    --max-time 30 \
    "${AUTH[@]}" \
    "${STRIPE_API}${path}" 2>&1) || {
    log "stripe_get ${path} failed: ${response}"
    return 2
  }
  printf '%s' "$response"
}

# stripe_post PATH FIELD=VALUE [FIELD=VALUE ...] — perform a POST with
# application/x-www-form-urlencoded body (curl --data-urlencode handles
# encoding of metadata[kairikos_tier]=starter correctly). Returns the JSON body.
stripe_post() {
  local path="$1"; shift
  local args=()
  while [[ $# -gt 0 ]]; do
    local kv="$1"
    local key="${kv%%=*}"
    local val="${kv#*=}"
    args+=(--data-urlencode "${key}=${val}")
    shift
  done
  local response
  response=$(curl --silent --show-error --fail-with-body \
    --max-time 30 \
    -X POST \
    "${AUTH[@]}" \
    "${args[@]}" \
    "${STRIPE_API}${path}" 2>&1) || {
    log "stripe_post ${path} failed: ${response}"
    return 2
  }
  printf '%s' "$response"
}

# jget FIELD JSON — extract a top-level string field via jq.
# For dotted paths like "data.0.id", jq handles them natively.
jget() {
  local field="$1" body="$2"
  printf '%s' "$body" | jq -r ".${field} // empty"
}

# jget_len JSON — count elements in data[] using jq.
jget_len() {
  local body="$1"
  printf '%s' "$body" | jq -r '.data | length'
}

# Look up an existing Kairikos Product for a given tier via metadata.
# Echoes "product_id price_id" or empty if not found.
find_existing_product() {
  local tier="$1"
  local response
  response=$(stripe_get "/products?limit=1&active=true&metadata[kairikos_tier]=${tier}") || return 0
  local count product_id default_price_id
  count=$(jget_len "$response")
  if [[ "$count" -gt 0 ]]; then
    product_id=$(jget 'data[0].id' "$response")
    default_price_id=$(jget 'data[0].default_price' "$response")
    # default_price may be an object (if expanded) or a string id.
    if [[ "$default_price_id" == "{"* ]]; then
      default_price_id=$(printf '%s' "$default_price_id" | jq -r '.id // empty')
    fi
    printf '%s %s\n' "$product_id" "$default_price_id"
  fi
}

# Create a Product with one recurring EUR price. Echoes "product_id price_id".
create_product_with_price() {
  local tier="$1"
  local name="${PRODUCT_NAME[$tier]}"
  local cents="${PRICE_CENTS[$tier]}"
  log "creating Product ${name} (${cents} cents EUR / month)"

  local prod_response price_response
  prod_response=$(stripe_post /products \
    "name=${name}" \
    "metadata[kairikos_tier]=${tier}" \
    "metadata[kairikos_product]=kairikos-portal" \
    "description=Kairikos ${tier} tier subscription — $(awk "BEGIN{printf \"%.2f\", ${cents}/100}") EUR / month" \
  ) || return 2

  local product_id
  product_id=$(jget 'id' "$prod_response")
  if [[ -z "$product_id" ]]; then
    log "product create returned no id: ${prod_response}"
    return 2
  fi
  log "  product created: ${product_id}"

  price_response=$(stripe_post /prices \
    "product=${product_id}" \
    "unit_amount=${cents}" \
    "currency=eur" \
    "recurring[interval]=month" \
    "recurring[usage_type]=licensed" \
  ) || return 2

  local price_id
  price_id=$(jget 'id' "$price_response")
  if [[ -z "$price_id" ]]; then
    log "price create returned no id: ${price_response}"
    return 2
  fi
  log "  price created: ${price_id}"

  printf '%s %s\n' "$product_id" "$price_id"
}

# ---------------------------------------------------------------------------
# Main — process each tier
# ---------------------------------------------------------------------------

declare -A RESULT_PRICE_ID

for tier in starter pro premium; do
  log "=== tier: ${tier} ==="
  pair=$(find_existing_product "$tier" || true)
  if [[ -n "$pair" ]]; then
    existing_product=$(echo "$pair" | awk '{print $1}')
    existing_price=$(echo "$pair" | awk '{print $2}')
    if [[ -n "$existing_price" ]]; then
      log "  reusing existing product=${existing_product} price=${existing_price}"
      RESULT_PRICE_ID[$tier]="$existing_price"
      continue
    fi
    # Existing product but no default price — create a price and link it.
    log "  existing product=${existing_product} has no default price, creating price"
    price_response=$(stripe_post /prices \
      "product=${existing_product}" \
      "unit_amount=${PRICE_CENTS[$tier]}" \
      "currency=eur" \
      "recurring[interval]=month" \
      "recurring[usage_type]=licensed" \
    ) || { log "failed to create price for existing product"; exit 3; }
    new_price=$(jget 'id' "$price_response")
    RESULT_PRICE_ID[$tier]="$new_price"
    continue
  fi
  pair=$(create_product_with_price "$tier") || {
    log "failed to create product for tier ${tier}"
    exit 3
  }
  new_product=$(echo "$pair" | awk '{print $1}')
  new_price=$(echo "$pair" | awk '{print $2}')
  RESULT_PRICE_ID[$tier]="$new_price"
done

# Emit the JSON map and the shell exports so the caller can `eval` the
# output. NEVER echo the secret key; only the public price IDs.
cat <<JSON
{
  "starter": "${RESULT_PRICE_ID[starter]}",
  "pro": "${RESULT_PRICE_ID[pro]}",
  "premium": "${RESULT_PRICE_ID[premium]}"
}
JSON

cat <<SHELL
export STRIPE_PRICE_ID_STARTER='${RESULT_PRICE_ID[starter]}'
export STRIPE_PRICE_ID_PRO='${RESULT_PRICE_ID[pro]}'
export STRIPE_PRICE_ID_PREMIUM='${RESULT_PRICE_ID[premium]}'
SHELL

log "all three tiers created/reused successfully"