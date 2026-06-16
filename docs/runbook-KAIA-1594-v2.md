# Runbook — KAIA-1594 v2 (Option A: provider-native secret stores)

> **Scope:** This is the operational runbook for the KAIA-1594 v2 cutover.
> It supersedes the 1Password-based patterns in [runbook-KAIA-1108.md](./runbook-KAIA-1108.md) for the seven secrets named below. The KAIA-1108 runbook remains the operational artifact for the `rotate-now` worker (`portal/scripts/rotate-secret.ts`); KAIA-1594 v2 is the operational artifact for the agent-side secret materialisation. They overlap on the **what** (rotate these values) and diverge on the **how** (GCP Secret Manager vs 1Password).
>
> **Decision of record:** Option A, set by the CEO on 2026-06-16T22:12Z (see [KAIA-1594 plan v2](/KAI/issues/KAIA-1594#document-plan)).

## The contract

`adapterConfig.env` is the agent's **public configuration**. It contains no secret material — only project IDs, project refs, project names, and the `KAIRIKOS_SECRET_BACKEND` marker. Secret material lives in the provider's own secret store and is materialised into the agent's process environment at run time via `scripts/load-secrets.sh`.

Three rules that govern every materialised value:

1. **Never** `echo`, `printenv`, log, or pipe the materialised value to a comment, screenshot, chat message, or commit body.
2. **Never** write the materialised value back into `adapterConfig.env`, the repo, or any other persistent surface.
3. **Never** commit a known-bad credential prefix to a tracked file; `make secrets-check` enforces this in CI and locally.

## Materialise-once helper

`scripts/load-secrets.sh` (sourced, not executed) reads `GCP_PROJECT_ID`, `GCP_SECRETS_PREFIX`, and `KAIRIKOS_SECRET_BACKEND` from the environment and pulls each of the seven secrets listed below. It is the only supported materialise path. Every agent that needs a secret sources it at the top of its run.

If `gcloud` is not on `PATH`, the script fails fast with an actionable error (install `google-cloud-cli` on the agent host). The script does **not** echo any materialised value, even in verbose mode.

## Per-secret runbook

For each secret: where the source of truth lives, the agent-side fetch command, the rotation procedure, and the recovery path if the GCP service account key itself is rotated.

### 1. `SUPABASE_DB_PASSWORD`

- **Source of truth:** GCP Secret Manager — `kairikos-secrets/supabase-db-password`. A derived secret `kairikos-secrets/supabase-db-url` (a full `postgres://...pooler.supabase.com:6543/...` URL) is also stored in Secret Manager so the agent does not have to assemble the URL from pieces.
- **Agent-side fetch:** `source scripts/load-secrets.sh` (handled by the helper). The script exports both `SUPABASE_DB_PASSWORD` and `SUPABASE_DB_URL` if not already set in the environment.
- **Rotation procedure (operator — CEO):**
  1. Reset the database password at the Supabase dashboard (Settings → Database → Reset password).
  2. Re-derive the pooler URL with the new password and store it in `kairikos-secrets/supabase-db-url`.
  3. Update `kairikos-secrets/supabase-db-password` with the new value.
  4. Verify by sourcing the helper in a CTO shell and running a no-op query (e.g. `psql "$SUPABASE_DB_URL" -c '\dt'`).
  5. Update the [KAIA-1610](/KAI/issues/KAIA-1610) issue with the new rotation timestamp.
- **Recovery if the GCP service account key is rotated:** the SA key materialised to `GOOGLE_APPLICATION_CREDENTIALS` is itself stored at `kairikos-secrets/gcp-sa-key`. Re-run the SA-key materialisation step from the host where the key is rotated. The CTO and Backend Developer agents must restart their runtimes to pick up the new key.

### 2. `SUPABASE_ACCESS_TOKEN`

- **Source of truth:** GCP Secret Manager — `kairikos-secrets/supabase-access-token` (a project-scoped PAT, scoped to the `kairikos` project, 90-day rotation cadence).
- **Agent-side fetch:** `source scripts/load-secrets.sh`.
- **Rotation procedure (operator — CEO):**
  1. Issue a new project-scoped PAT in the Supabase dashboard.
  2. Update `kairikos-secrets/supabase-access-token` with the new value.
  3. Revoke the old PAT.
  4. Verify by sourcing the helper in a CTO shell and running `supabase projects list` (or the next agent run).
- **Recovery if the GCP SA key is rotated:** see `SUPABASE_DB_PASSWORD` §.

### 3. `GOOGLE_API_KEY`

- **Source of truth:** GCP Secret Manager — `kairikos-secrets/google-api-key`.
- **Agent-side fetch:** `source scripts/load-secrets.sh`.
- **Rotation procedure (operator — CEO):**
  1. Create a new API key in the Google Cloud Console (APIs & Services → Credentials).
  2. Update `kairikos-secrets/google-api-key` with the new value.
  3. Delete the old key after a 24-hour grace window.
  4. Verify by sourcing the helper in a CTO shell and running `curl -H "x-goog-api-key: $GOOGLE_API_KEY" https://generativelanguage.googleapis.com/v1/models`.
- **Recovery if the GCP SA key is rotated:** see `SUPABASE_DB_PASSWORD` §.

### 4. `WP_ADMIN_PASSWORD`

- **Source of truth:** GCP Secret Manager — `kairikos-secrets/wp-admin-password`. WordPress itself does not expose a programmatic secret store; the operator rotates the WP password at the host and writes the new value into Secret Manager.
- **Agent-side fetch:** `source scripts/load-secrets.sh`.
- **Rotation procedure (operator — CEO):**
  1. End any active WP admin session under the previous password.
  2. Rotate at the WP host (Hostinger hPanel — see [KAIA-845](/KAI/issues/KAIA-845) for the Hostinger WAF 429 caveat: the rotation may need to be retried or performed from a different IP).
  3. Update `kairikos-secrets/wp-admin-password` with the new value.
  4. Verify by sourcing the helper in a CTO shell and running `wp-cli --user="$WP_ADMIN_EMAIL" --ask-pass user list` (or the next agent run).
- **Recovery if the GCP SA key is rotated:** see `SUPABASE_DB_PASSWORD` §.

### 5. `DASHSCOPE_API_KEY`

- **Source of truth:** GCP Secret Manager — `kairikos-secrets/dashscope-api-key`. CMO-owned rotation cadence (90 days recommended).
- **Agent-side fetch:** `source scripts/load-secrets.sh`.
- **Rotation procedure (operator — CEO):**
  1. Rotate at the DashScope console.
  2. Update `kairikos-secrets/dashscope-api-key` with the new value.
  3. Delete the old key at the DashScope console.
  4. Verify by sourcing the helper in a CMO shell and running the next CMO task.
- **Recovery if the GCP SA key is rotated:** see `SUPABASE_DB_PASSWORD` §.

### 6. `SUPABASE_SERVICE_ROLE_KEY`

- **Source of truth:** GCP Secret Manager — `kairikos-secrets/supabase-service-role-key`. This is a **storage move** from the [KAIA-1591](/KAI/issues/KAIA-1591) 1Password handoff; the value itself is the same JWT, but the agent no longer references it via the 1Password OP_REF.
- **Agent-side fetch:** `source scripts/load-secrets.sh`.
- **Rotation procedure (operator — CEO):**
  1. Rotate the service role key at the Supabase dashboard (Settings → API → Service Role → Roll).
  2. Update `kairikos-secrets/supabase-service-role-key` with the new value.
  3. Verify by sourcing the helper in a CTO shell and running a no-op query against the Supabase REST API.
  4. Delete the [KAIA-1591](/KAI/issues/KAIA-1591) 1Password item if it exists.
- **Recovery if the GCP SA key is rotated:** see `SUPABASE_DB_PASSWORD` §.

### 7. `VERCEL_TOKEN`

- **Source of truth:** Vercel project env (the `project-fxidg` project's environment, set via `vercel env add`). **Not** in the agent's `adapterConfig.env`.
- **Agent-side fetch:** the agent uses `vercel link` once per workspace to bind to the project, and `vercel deploy` and friends pick up the project env automatically. No Vercel token is materialised in the script.
- **Rotation procedure (operator — CEO):**
  1. Revoke the leaked token at the Vercel dashboard (see [KAIA-1595](/KAI/issues/KAIA-1595) for the originating leak).
  2. Issue a new project-scoped token.
  3. `vercel link` against `project-fxidg` in the agent workspace.
  4. `vercel env add VERCEL_TOKEN production` and paste the new value.
  5. Verify by running `vercel env ls` in the linked workspace.
- **Recovery if the GCP SA key is rotated:** N/A — VERCEL_TOKEN is not in GCP Secret Manager.

## What to do if `scripts/load-secrets.sh` fails

1. The script prints an actionable error to stderr. The most common cause on a fresh host is the missing `gcloud` CLI: install `google-cloud-cli` (apt) or download the tarball.
2. If `gcloud` is installed but the helper errors on a specific secret, check the GCP Secret Manager console for that secret name. The script's `_resolve` wraps `gcloud secrets versions access latest --secret="${GCP_SECRETS_PREFIX}${1}"` — the `<name>` here is the value in the inventory above.
3. If the GCP service account key is rotated and the helper errors with a 403 / "permission denied", re-materialise the SA key from `kairikos-secrets/gcp-sa-key` and re-source the helper.

## See also

- [KAIA-1594 plan v2](/KAI/issues/KAIA-1594#document-plan) — the decision of record
- [KAIA-1613](/KAI/issues/KAIA-1613) — shipping acceptance for `scripts/load-secrets.sh`
- [KAIA-1108 runbook](./runbook-KAIA-1108.md) — the pre-Option-A 1Password worker (overlapping scope; do not retire until v1.1 lands)
- [KAIA-1611](/KAI/issues/KAIA-1611) — rotate-now worker re-pointed at GCP Secret Manager
- [secrets-guardrail.md](./secrets-guardrail.md) — the CI guardrail that prevents a plain-text value from being committed
- [KAIA-1162](/KAI/issues/KAIA-1162) — the v1.1 credentials vault design (umbrella for the long-term Workload Identity Federation path)
