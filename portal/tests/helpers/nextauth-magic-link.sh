#!/bin/bash
# Generate NextAuth magic links by writing tokens directly to the DB
# Usage: bash helpers/nextauth-magic-link.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

source "$PROJECT_DIR/../../../.env"

SUPABASE_URL="${SUPABASE_URL}"
SERVICE_KEY="${SUPABASE_SERVICE_ROLE_KEY}"
PORTAL_URL="${PORTAL_URL:-https://project-fxidg.vercel.app}"

generate_token() {
  openssl rand -hex 32
}

for entry in "onboarding-test1@kairikos.dev|Starter" "onboarding-test2@kairikos.dev|Pro" "staff-test@kairikos.dev|operator"; do
  EMAIL="${entry%%|*}"
  LABEL="${entry##*|}"
  TOKEN="$(generate_token)"
  EXPIRES="$(date -u -d '+24 hours' +'%Y-%m-%dT%H:%M:%S.000Z')"

  # Delete old tokens for this email
  curl -s -X DELETE \
    "$SUPABASE_URL/rest/v1/VerificationToken?identifier=eq.${EMAIL}" \
    -H "apikey: $SERVICE_KEY" \
    -H "Authorization: Bearer $SERVICE_KEY" \
    -H "Content-Type: application/json" > /dev/null

  # Insert new token
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    "$SUPABASE_URL/rest/v1/VerificationToken" \
    -H "apikey: $SERVICE_KEY" \
    -H "Authorization: Bearer $SERVICE_KEY" \
    -H "Content-Type: application/json" \
    -H "Prefer: resolution=merge-duplicates" \
    -d "{\"identifier\":\"$EMAIL\",\"token\":\"$TOKEN\",\"expires\":\"$EXPIRES\"}")

  if [ "$STATUS" = "201" ]; then
    echo "$LABEL: ${PORTAL_URL}/api/auth/callback/nodemailer?token=${TOKEN}&email=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$EMAIL'))")"
  else
    echo "FAIL $LABEL ($EMAIL): HTTP $STATUS"
  fi
done