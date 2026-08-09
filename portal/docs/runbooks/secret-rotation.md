# Secret Rotation Runbook

**Issue:** [KAIA-1108](/KAI/issues/KAIA-1108)
**Last updated:** 2026-06-13

## Overview

The rotate-now worker (`scripts/rotate-secret.ts`) handles secret rotation for four integrations: Resend, n8n, Portal API Key, and Postgres Password. The worker is the **only** system component that talks to 1Password — the settings page and settings API never see secret values.

## Automatic Rotations (portal_api_key, postgres_password)

These two integrations can rotate automatically via the API:

```bash
curl -X POST https://portal.kairikos.com/api/internal/rotate-secret \
  -H "x-portal-api-key: $PORTAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"toolKey": "portal_api_key"}'
```

Response:
```json
{"ok": true, "toolKey": "portal_api_key", "newValue": "<hex-key>", "lastRotatedAt": "..."}
```

The new `newValue` must then be manually written to 1Password by the operator.

## Manual Rotations (resend, n8n)

Resend and n8n do not expose API-based key rotation. These require a manual step:

### Resend

1. Go to [https://resend.com/api-keys](https://resend.com/api-keys)
2. Create a new API key
3. Update the 1Password item "Resend API Key" → password field with the new key
4. Trigger a portal redeploy so n8n and other consumers pick up the new key

### n8n

1. Go to `n8n.srv1170607.hstgr.cloud` → Settings → API Key
2. Regenerate the API key
3. Update the 1Password item "n8n API Key" → password field with the new key
4. Update the n8n credential vault with the new key

## Manual Fallback (Full Procedure)

If the rotate-now worker fails or 1Password is unavailable:

### Step 1: Rotate in 1Password

1. Log into 1Password (Kairikos team vault)
2. Find the item (e.g., "Portal API Key")
3. Open the item → password field → Generate new password
4. Save the new value

### Step 2: Update the Running Container

```bash
# SSH to the VPS
ssh operator@<vps-host>

# Update the env var on the running container
docker exec kairikos-portal-app-1 sh -c "PORTAL_API_KEY='<new-value>' && echo OK"

# Restart the container to pick up the new env var
docker restart kairikos-portal-app-1
```

### Step 3: Verify

```bash
# Check the container has the new value
docker exec kairikos-portal-app-1 env | grep PORTAL_API_KEY

# Check the portal is responding
curl https://portal.kairikos.com/api/health
```

### Step 4: Trigger Redeploy (if needed)

If the portal is behind a reverse proxy or requires a full redeploy:

```bash
cd /opt/kairikos/portal
docker-compose down
docker-compose up -d
```

## 1Password Service Account Token Rotation

The Service Account token itself must be rotated every 90 days.

1. Log into 1Password as an admin
2. Go to the Kairikos team vault → Service Accounts
3. Find the "Kairikos Rotate Worker" service account
4. Rotate the token
5. Update the token in the VPS environment:
   - Edit the `OP_SERVICE_ACCOUNT_TOKEN` env var in the docker-compose.yml or env file
   - Restart the rotate-worker container if it is running separately

## Blast Radius Notes

- **portal_api_key rotation**: The next n8n callback or `notify-operator` call will use the new key. If rotation happens mid-request, the in-flight request fails and retries with the new key. This is acceptable because the key is a bearer token.
- **postgres_password rotation**: Rotate while the portal is under low load. The worker attempts to drain connections before rotating, but for manual rotation, prefer a maintenance window.
- **resend / n8n**: These are manual-only. No blast radius from automation.

## Escalation

If anything is unclear or the manual fallback fails, escalate to the CTO.
