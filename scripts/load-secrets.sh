#!/usr/bin/env bash
# scripts/load-secrets.sh — materialise agent secrets from the chosen backend.
#
# Source this; do not execute. Never echo, log, printenv, or pipe the
# materialised values to a comment, screenshot, or commit body.
#
# Public configuration (project IDs, project refs, project names, and the
# KAIRIKOS_SECRET_BACKEND marker) lives in adapterConfig.env. The actual
# secret material lives in the provider's own secret store and is pulled
# into the script's process environment only. Nothing is written back to
# adapterConfig.env. The [[ -n "${X:-}" ]] || export X=... pattern means
# "if the env var is already set (e.g. from a CI override), keep it;
# otherwise pull from the backend" — materialise-once semantics.
#
# See KAIA-1594 plan v2 for the Option A decision and the secret-name
# inventory. See KAIA-1613 for the script's shipping acceptance criteria.

set -euo pipefail

: "${KAIRIKOS_SECRET_BACKEND:?KAIRIKOS_SECRET_BACKEND must be set in adapterConfig.env (e.g. gcp_secret_manager)}"

case "$KAIRIKOS_SECRET_BACKEND" in
  gcp_secret_manager)
    : "${GCP_PROJECT_ID:?GCP_PROJECT_ID must be set in adapterConfig.env}"
    : "${GCP_SECRETS_PREFIX:?GCP_SECRETS_PREFIX must be set (e.g. kairikos-secrets/)}"

    if ! command -v gcloud >/dev/null 2>&1; then
      echo "load-secrets: gcloud CLI is not on PATH" >&2
      echo "load-secrets: install google-cloud-cli on the agent host (KAIA-1613 acceptance blocker)" >&2
      return 1
    fi

    _resolve() {
      gcloud secrets versions access latest \
        --project="$GCP_PROJECT_ID" \
        --secret="${GCP_SECRETS_PREFIX}${1}" \
        2>/dev/null
    }
    ;;
  *)
    echo "load-secrets: unknown KAIRIKOS_SECRET_BACKEND: $KAIRIKOS_SECRET_BACKEND" >&2
    return 1
    ;;
esac

# VERCEL_TOKEN is intentionally NOT resolved here — Vercel project env
# handles it via `vercel link` / `vercel env pull`. The agent does not
# need to pull a Vercel token at run time.
[[ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]] || export SUPABASE_SERVICE_ROLE_KEY="$(_resolve supabase-service-role-key)"
[[ -n "${SUPABASE_ACCESS_TOKEN:-}"      ]] || export SUPABASE_ACCESS_TOKEN="$(_resolve supabase-access-token)"
[[ -n "${SUPABASE_DB_PASSWORD:-}"       ]] || export SUPABASE_DB_PASSWORD="$(_resolve supabase-db-password)"
[[ -n "${SUPABASE_DB_URL:-}"            ]] || export SUPABASE_DB_URL="$(_resolve supabase-db-url)"
[[ -n "${GOOGLE_API_KEY:-}"             ]] || export GOOGLE_API_KEY="$(_resolve google-api-key)"
[[ -n "${WP_ADMIN_PASSWORD:-}"          ]] || export WP_ADMIN_PASSWORD="$(_resolve wp-admin-password)"
[[ -n "${DASHSCOPE_API_KEY:-}"          ]] || export DASHSCOPE_API_KEY="$(_resolve dashscope-api-key)"

unset -f _resolve
