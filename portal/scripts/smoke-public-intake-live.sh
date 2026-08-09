#!/usr/bin/env bash
# =============================================================================
# scripts/smoke-public-intake-live.sh — KAIA-2913
#
# One-command end-to-end smoke for POST /api/public/intake. Designed for
# the CEO ↔ Vercel env-var loop: ~3 s runtime, per-check pass/fail, and
# precise diagnosis of missing / misconfigured env vars without grepping
# the Vercel logs.
#
# Usage:
#   ./scripts/smoke-public-intake-live.sh                                       # default URL
#   ./scripts/smoke-public-intake-live.sh --url https://project-fxidg-xxx.vercel.app
#   ./scripts/smoke-public-intake-live.sh --url <URL> --email ceo@test.com
#
# Requirements: curl + jq. No node, no python, no build step.
#
# Exit: 0 on full pass, 1 on any failed check.
# =============================================================================

set -uo pipefail

URL_DEFAULT="https://project-fxidg-88lsv38x2-orlandos-projects-70991066.vercel.app"
URL="$URL_DEFAULT"
EMAIL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)   URL="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --help|-h)
      grep -E '^#( |!)' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)       echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if ! command -v curl >/dev/null 2>&1; then
  echo "ERROR: curl is required" >&2; exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required (apt-get install jq / brew install jq)" >&2; exit 2
fi

EMAIL="${EMAIL:-smoke-$(date +%s)-$$@kairikos.com}"
KEY="smoke-$(date +%s%N)"

PASS=0; FAIL=0; WARN=0
note() {
  local level="$1"; shift
  case "$level" in
    pass) printf '  \033[32mPASS\033[0m  %s\n' "$*"; PASS=$((PASS+1)) ;;
    fail) printf '  \033[31mFAIL\033[0m  %s\n' "$*"; FAIL=$((FAIL+1)) ;;
    warn) printf '  \033[33mWARN\033[0m  %s\n' "$*"; WARN=$((WARN+1)) ;;
  esac
}
banner() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

read_http() {
  # Splits a "BODY\n__HTTP__NNN" curl capture into the HTTP code + the body.
  local raw="$1"
  if [[ "${raw}" =~ __HTTP__([0-9]+)$ ]]; then
    HTTP_CODE="${BASH_REMATCH[1]}"
    BODY="$(echo "${raw}" | sed 's/__HTTP__[0-9]*$//')"
  else
    HTTP_CODE="???"
    BODY="${raw}"
  fi
}

PAYLOAD='{
  "business_name":"Smoke Test Co",
  "sector":"clínica dental",
  "short_description":"Smoke test description for automated check",
  "voice_tone":"cercano","pronoun":"tú","language":["español"],
  "business_hours_weekday":"9-18","business_hours_weekend":"10-14",
  "out_of_hours_behavior":"dejar mensaje",
  "faqs":[
    {"q":"Q1","a":"A1"},{"q":"Q2","a":"A2"},{"q":"Q3","a":"A3"},{"q":"Q4","a":"A4"},
    {"q":"Q5","a":"A5"},{"q":"Q6","a":"A6"},{"q":"Q7","a":"A7"},{"q":"Q8","a":"A8"},
    {"q":"Q9","a":"A9"},{"q":"Q10","a":"A10"}
  ],
  "channels_enabled":["web"],
  "human_handoff_email":"'"${EMAIL}"'",
  "human_handoff_hours":"9-18","escalation_triggers":"none",
  "gdpr_responsible_email":"'"${EMAIL}"'",
  "privacy_url":"https://example.com/privacy"
}'

post() {
  local idem="$1" body="$2"
  curl -sS -X POST "${URL}/api/public/intake" \
    -H "Content-Type: application/json" \
    -H "X-Idempotency-Key: ${idem}" \
    -d "${body}" \
    -w '\n__HTTP__%{http_code}'
}

banner "Target"
echo "  URL:   ${URL}"
echo "  Email: ${EMAIL}"

# ---- 1. Reach --------------------------------------------------------------
banner "1. Function reachable (GET /)"
HTTP_CODE=$(curl -sS -o /dev/null -w '%{http_code}' "${URL}/" 2>&1 || echo "000")
case "${HTTP_CODE}" in
  200|307|308) note pass "Root URL responds ${HTTP_CODE} (function runtime alive)" ;;
  404)         note pass "Root URL 404 (no / route; runtime is up)" ;;
  502|503|504) note fail "Runtime is down (${HTTP_CODE}) — Vercel build/deploy is broken" ;;
  000)         note fail "Connection refused / DNS failure — URL is wrong or unreachable" ;;
  *)           note warn "Unexpected root response: ${HTTP_CODE}" ;;
esac

# ---- 2. Method guard --------------------------------------------------------
banner "2. Method guard (GET /api/public/intake)"
RAW=$(curl -sS -i -X GET "${URL}/api/public/intake")
HTTP_TOP=$(echo "${RAW}" | head -1 | tr -d '\r')
if [[ "${HTTP_TOP}" =~ 405 ]]; then
  note pass "GET → 405 method_not_allowed (route wired)"
else
  note fail "GET did not return 405 — got '${HTTP_TOP}'"
fi

# ---- 3. Zod validation ------------------------------------------------------
banner "3. Zod validation rejects empty payloads"
RAW=$(curl -sS -X POST "${URL}/api/public/intake" \
  -H "Content-Type: application/json" -d '{}' \
  -w '\n__HTTP__%{http_code}')
read_http "${RAW}"
if [[ "${HTTP_CODE}" == "400" ]]; then
  ERR=$(echo "${BODY}" | jq -r '.error // ""' 2>/dev/null)
  if [[ "${ERR}" == "validation_failed" ]]; then
    note pass "Empty payload → 400 validation_failed (Zod schema live)"
  else
    note fail "400 returned but error≠validation_failed (got '${ERR}')"
  fi
else
  note fail "Empty payload expected 400, got ${HTTP_CODE}"
fi

# ---- 4. End-to-end smoke ----------------------------------------------------
banner "4. End-to-end smoke (valid 26-field payload)"
RAW=$(post "${KEY}-main" "${PAYLOAD}")
read_http "${RAW}"
echo "  HTTP:    ${HTTP_CODE}"
if [[ -n "${BODY}" ]]; then
  echo "  Body:    $(echo "${BODY}" | jq -c .)"
fi

if [[ "${HTTP_CODE}" != "200" ]]; then
  note fail "End-to-end smoke returned ${HTTP_CODE} (expected 200)"
  echo -e "\n  \033[31m-- Full response --\033[0m"
  echo "${BODY}" | jq . 2>/dev/null || echo "${BODY}"
else
  note pass "End-to-end smoke returned 200"
fi

SUBMISSION_ID=$(echo "${BODY}" | jq -r '.submissionId // ""' 2>/dev/null)
DRIVE_FOLDER=$(echo "${BODY}"  | jq -r '.drive.folderId // ""' 2>/dev/null)
DRIVE_SKIP=$(echo "${BODY}"    | jq -r '.drive.skipped // ""' 2>/dev/null)
DAY2_ID=$(echo "${BODY}"       | jq -r '.day2Issue.issueIdentifier // ""' 2>/dev/null)
DAY2_SKIP=$(echo "${BODY}"     | jq -r '.day2Issue.skipped // ""' 2>/dev/null)
CLIENT_ID=$(echo "${BODY}"     | jq -r '.clientId // ""' 2>/dev/null)

if [[ -n "${SUBMISSION_ID}" && "${SUBMISSION_ID}" != "null" ]]; then
  note pass "IntakeSubmission row created: ${SUBMISSION_ID} (clientId=${CLIENT_ID})"
else
  note fail "No submissionId in 200 response — DB write didn't happen"
fi

# Drive side effect
if [[ -n "${DRIVE_FOLDER}" && "${DRIVE_FOLDER}" != "null" ]]; then
  note pass "Drive folder created: ${DRIVE_FOLDER}"
elif [[ "${DRIVE_SKIP}" == "replay" ]]; then
  note pass "Drive skipped=replay (idempotent replay, expected)"
elif [[ "${DRIVE_SKIP}" == "not_configured" ]]; then
  note fail "Drive not_configured — Vercel env vars missing: GOOGLE_OAUTH_REFRESH_TOKEN / GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET (set in Vercel → Settings → Environment Variables, scope=Production+Preview+Development)"
elif [[ "${DRIVE_SKIP}" == "auth_failed" ]]; then
  note fail "Drive auth_failed — env vars set but Google's OAuth refresh was rejected. Common causes: (1) refresh token revoked/expired, (2) wrong client_id/secret for that refresh token's OAuth app, (3) pasted with whitespace. Re-mint via https://developers.google.com/oauthplayground/ with scope=https://www.googleapis.com/auth/drive.file"
elif [[ "${DRIVE_SKIP}" == "api_error" ]]; then
  note fail "Drive api_error — token minted, but Drive API rejected. Check that the OAuth user owns DRIVE_PARENT_FOLDER_ID and the OAuth scopes include drive.file."
else
  note fail "Drive side effect skipped value unknown: '${DRIVE_SKIP}'"
fi

# Day-2 Paperclip side effect
if [[ -n "${DAY2_ID}" && "${DAY2_ID}" != "null" ]]; then
  note pass "Day-2 Paperclip issue created: ${DAY2_ID}"
elif [[ "${DAY2_SKIP}" == "replay" ]]; then
  note pass "Day-2 skipped=replay (idempotent replay, expected)"
elif [[ "${DAY2_SKIP}" == "not_configured" ]]; then
  note fail "Day-2 not_configured — Vercel env vars missing: PAPERCLIP_API_URL / PAPERCLIP_API_KEY / PAPERCLIP_COMPANY_ID"
elif [[ "${DAY2_SKIP}" == "api_error" ]]; then
  note fail "Day-2 api_error — Paperclip creds set, but Paperclip API rejected. Verify PAPERCLIP_API_KEY is valid and the URL is reachable from Vercel."
else
  note fail "Day-2 side effect skipped value unknown: '${DAY2_SKIP}'"
fi

# ---- 5. Idempotency replay --------------------------------------------------
banner "5. Idempotency replay (re-POST same key)"
RAW=$(post "${KEY}-main" "${PAYLOAD}")
read_http "${RAW}"
if [[ "${HTTP_CODE}" == "200" ]]; then
  SUB2=$(echo "${BODY}" | jq -r '.submissionId // ""' 2>/dev/null)
  if [[ "${SUB2}" == "${SUBMISSION_ID}" && -n "${SUB2}" && "${SUB2}" != "null" ]]; then
    note pass "Replay returned same submissionId (idempotency working)"
  else
    note fail "Replay returned different submissionId ('${SUB2}' != '${SUBMISSION_ID}')"
  fi
else
  note warn "Replay returned HTTP ${HTTP_CODE} — skipping idempotency check"
fi

# ---- Summary ---------------------------------------------------------------
banner "Summary"
printf '  \033[32mPass: %s\033[0m  \033[31mFail: %s\033[0m  \033[33mWarn: %s\033[0m\n' "${PASS}" "${FAIL}" "${WARN}"
echo ""

if [[ ${FAIL} -gt 0 ]]; then
  cat <<'GUIDE'

Diagnostic loop (each iteration < 30 s):
  1. Edit Vercel env vars (Settings → Environment Variables → Save). Save
     auto-redeploys the latest commit on the branch — wait ~30 s.
  2. Re-run this script. The fail messages name the exact env var that
     is missing / wrong / expired, so you don't have to guess.
  3. Common Vercel dashboard gotchas:
     - "Plain Text" vs "Sensitive" — both work for secret material; just
       paste. Vercel encrypts at rest either way.
     - "Environment" scope — must include Production AND Preview AND
       Development for preview URLs to see the value.
     - Newline at end of pasted value — usually harmless; Node strips it.
  4. If Vercel env vars look correct but smoke still shows the same
     failure, paste the exact fail message back into the issue thread
     (with timestamp + the exact error line).
GUIDE
  exit 1
fi

echo -e "  \033[32mAll required checks pass. The intake endpoint is live.\033[0m"
exit 0
