# Secrets guardrail (KAIA-1597, KAIA-1594 v2)

This document describes the plain-text-secrets guardrail added on 2026-06-16 in response to the Vercel token leak documented in [KAIA-1597](/KAIA/issues/KAIA-1597) and the parent incident [KAIA-1592](/KAIA/issues/KAIA-1592), and updated on 2026-06-17 to point at the Option A secret-store model adopted under [KAIA-1594 plan v2](/KAI/issues/KAIA-1594#document-plan).

## Goal

Make it **impossible** to commit a known-bad credential prefix to a tracked file, and make it **operationally cheap** to extend the check as new secret shapes are discovered.

## What we run

`scripts/secrets-check.sh` scans tracked files (via `git ls-files`) for these patterns:

- `vcp_…`  — Vercel API tokens
- `sbp_…`  — Supabase personal access tokens
- `sk-…`   — OpenAI / Stripe / Resend live keys
- `AIza…`  — Google API keys
- `eyJ…`   — JWTs (Supabase anon/service-role, Auth0, etc.)
- `postgres://<user>:<non-placeholder-pwd>@<host>` — Postgres DSNs

The full regex set lives in `scripts/secrets-patterns.txt`. To extend, add a line and a comment.

## How to run it

- Locally: `make secrets-check` or `npm --prefix portal run secrets:check`
- In CI: `.github/workflows/secrets-check.yml` runs on every PR and push to `main`. PRs cannot be merged if the scan fails.
- As a pre-commit hook: see "Optional: pre-commit" below.

## Allowing an exception

If a tracked file must contain a sample value (test fixture, runbook example), do **one** of:

1. Use the literal word `placeholder`, `PLACEHOLDER`, `EXAMPLE`, or `changeme` in the value. These are recognised by the pattern file and pass the scan.
2. Add the file path to `scripts/secrets-allowlist.txt` with a one-line reason. Every entry is reviewed in PR — adding an entry is a CTO-level decision.

Do **not** add a comment-based allowlist inside the pattern file; that hides intent.

## What to do when a value is in the wrong place

Under the Option A model adopted in [KAIA-1594 plan v2](/KAI/issues/KAIA-1594#document-plan), secret material never lives in `adapterConfig.env` and never lives in the repo. The supported flow:

1. **Rotate** the credential (assume it is compromised; see the per-secret runbook under [runbook-KAIA-1594-v2.md](./runbook-KAIA-1594-v2.md)).
2. **Store** the new value in the provider's own secret store: Vercel project env for `VERCEL_TOKEN`; Supabase project env for the Supabase project secrets; GCP Secret Manager under the `kairikos-secrets/` prefix for everything else.
3. **Replace** the plain value in any file with the public configuration (project IDs, project refs, project names) or the `KAIRIKOS_SECRET_BACKEND` marker. Source `scripts/load-secrets.sh` at the top of every agent run to materialise the secret into the process environment.
4. **Re-run** `make secrets-check`.

The pre-Option-A flow that wrote values into the 1Password vault and referenced them via `*_OP_REF` is **deprecated**. See the v2 plan for the rationale.

## Related

- Parent incident: [KAIA-1592](/KAIA/issues/KAIA-1592)
- Audit of agent `adapterConfig.env` plain-text secrets (Option A decision of record): [KAIA-1594](/KAI/issues/KAIA-1594)
- Per-secret runbook (Option A): [runbook-KAIA-1594-v2.md](./runbook-KAIA-1594-v2.md)
- Materialise-once helper: `scripts/load-secrets.sh` (see [KAIA-1613](/KAI/issues/KAIA-1613))
- Pre-Option-A 1Password runbook (overlapping scope; do not retire until v1.1 lands): [runbook-KAIA-1108.md](./runbook-KAIA-1108.md)
- v1.1 credentials vault (broader work): [KAIA-1162](/KAI/issues/KAIA-1162)

## Optional: pre-commit

To run this on every `git commit`, add to `.git/hooks/pre-commit`:

```bash
#!/usr/bin/env bash
exec bash scripts/secrets-check.sh
```

This is opt-in per developer workstation; the GitHub Actions check is the enforcement point.
