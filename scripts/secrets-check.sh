#!/usr/bin/env bash
# scripts/secrets-check.sh — fail if known secret prefixes appear in tracked files.
#
# Guardrail added after the 2026-06-16 Vercel token leak (KAIA-1597).
# Cheap grep-based check; no new dependency. Exits non-zero on any hit.
#
# Patterns flagged:
#   vcp_…       — Vercel API tokens
#   sbp_…       — Supabase personal access tokens
#   sk-…        — OpenAI / Stripe / Resend / etc. live keys
#   AIza…       — Google API keys
#   eyJ…        — JWTs (likely Supabase anon/service-role, Auth0, etc.)
#   postgres://<user>:<real-password>@<host>  — Postgres with non-placeholder pwd
#
# Allowed exceptions:
#   - Files matched by .gitignore (e.g. .env, .env.local, .env.*.local)
#   - The script itself and its sibling patterns file
#   - Build artefacts (.next/, playwright-report/, test-results/)
#   - The Dockerfile placeholder (uses the literal string "placeholder")
#   - Files in scripts/secrets-allowlist.txt
#   - Placeholder values: literal "PLACEHOLDER", "example", "changeme",
#     "REPLACE_ME" — anything using these as the password component of
#     a connection string is intentional and safe to ship.
#
# To intentionally ship a sample value (e.g. for a fixture), prefix the
# value with "EXAMPLE_" or use the literal word "placeholder" — both are
# recognised by the patterns file.
#
# See KAIA-1597 for the originating incident.

set -u

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$REPO_ROOT" ]; then
  echo "secrets-check: must be run from inside a git working tree" >&2
  exit 2
fi

cd "$REPO_ROOT"

# Files to scan: tracked files only, minus binaries and .gitignore'd files.
ALLOWLIST="$(dirname "$0")/secrets-allowlist.txt"
ALLOWLIST_GREP=""
if [ -f "$ALLOWLIST" ]; then
  ALLOWLIST_GREP="-v"
fi

mapfile -t FILES < <(git ls-files \
  | grep -vE '^\.git/' \
  | grep -vE '\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|eot|mp[34]|zip|tar|gz)$' \
  | grep -vE '^(portal/\.next/|portal/playwright-report/|portal/test-results/)' \
  | grep -vE '^(portal/tests/fixtures/.*\.(json|ts|sql))$' \
  | grep -vE '/(\.env\.example|\.env\.production\.example)$' \
  | grep -vE '^(portal/Dockerfile|scripts/secrets-(check|patterns|allowlist))' \
  | { if [ -f "$ALLOWLIST" ]; then grep -v -F -f "$ALLOWLIST"; else cat; fi; } \
)

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "secrets-check: no files to scan"
  exit 0
fi

PATTERNS_FILE="$(dirname "$0")/secrets-patterns.txt"
if [ ! -f "$PATTERNS_FILE" ]; then
  echo "secrets-check: missing patterns file: $PATTERNS_FILE" >&2
  exit 2
fi

FAIL=0
HITS=$(grep -nE -f "$PATTERNS_FILE" "${FILES[@]}" 2>/dev/null || true)
if [ -n "$HITS" ]; then
  echo "secrets-check: FAIL — possible secrets in tracked files:" >&2
  echo "$HITS" >&2
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  echo "" >&2
  echo "These patterns indicate plain-text credentials." >&2
  echo "Move the value to 1Password (KAIA-1108) and reference it via" >&2
  echo "secret_ref in adapter config, or via \${{ secrets.X }} in CI." >&2
  echo "If a hit is intentional (e.g. a test fixture, a docs example)," >&2
  echo "either add the file path to scripts/secrets-allowlist.txt with a" >&2
  echo "reason, or reword the value to use a clearly-fake prefix like" >&2
  echo "'PLACEHOLDER' / 'EXAMPLE_' so the regex does not match." >&2
  echo "See KAIA-1597 for the originating incident." >&2
  exit 1
fi

echo "secrets-check: OK — no plain-text secret prefixes found in $(printf '%s\n' "${FILES[@]}" | wc -l) tracked files"
exit 0
