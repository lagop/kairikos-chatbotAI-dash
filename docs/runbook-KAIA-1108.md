# Runbook — KAIA-1108: 1Password Service Account setup for rotate-now worker

> **Audience:** the operator (CTO or account owner who can create 1Password Service Accounts)
> **Time:** ~15 minutes, one-time setup
> **Frequency:** Rotate the Service Account token every 90 days

---

## What this is

The rotate-now worker (`scripts/rotate-secret.ts`) talks to 1Password to read/write
integration secrets. It uses a **1Password Service Account** (not a personal login)
so the automation can run without a human being logged in.

The Service Account needs the smallest possible vault access: read/write to exactly
the 4 items the worker touches.

---

## Step 1 — Create the Service Account

1. Open **1Password** (web or desktop) as a vault owner/admin.
2. Navigate to **Manage Vaults → [your vault] → Members → Service Accounts**.
3. Click **Add Service Account**.
4. Name: `kairikos-rotate-worker`
5. Vault access: select only the vault that holds the Kairikos integration secrets.
6. Permission level: **Read and Write** (the worker writes new rotated values).
7. Click **Create Service Account**.
8. **Copy the token immediately** — it is shown only once.

---

## Step 2 — Store the token securely

The Service Account token is itself a secret. Do not hardcode it.

**Recommended:** store it in 1Password (a different vault or a personal 1Password login
that the operator controls), then sync it to the VPS via the existing docker-compose
env injection pattern.

On the VPS, add to your `.env` or `docker-compose.yml` environment:

```bash
OP_SERVICE_ACCOUNT_TOKEN=<paste token here>
OP_VAULT_NAME=<your vault name, e.g. "Kairikos">
```

---

## Step 3 — Verify the 1Password items exist

The worker reads from these 1Password items (format: `op://<vault>/<item>/<field>`):

| toolKey | 1Password Item name | Field |
|---------|-------------------|-------|
| `resend` | Resend API Key | `password` |
| `n8n` | n8n API Key | `password` |
| `portal_api_key` | Portal API Key | `password` |
| `postgres_password` | Postgres Password | `password` |

Create each item if it does not already exist. The worker reads and writes the
`password` field of each item.

---

## Step 4 — Install the 1Password CLI on the VPS

The rotate worker requires the `op` CLI on the server:

```bash
# Debian/Ubuntu
curl -sS https://downloads.1password.com/linux/keys/1password.asc | gpg --dearmor > /tmp/1password.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/tmp/1password.gpg] https://downloads.1password.com/linux/debian $(dpkg --print-architecture) main" \
  | tee /etc/apt/sources.list.d/1password.list
apt update && apt install 1password-cli

# Or via brew (macOS)
brew install 1password-cli
```

Verify: `op --version`

---

## Step 5 — Test the worker (dry run)

```bash
cd ~/kairikos-portal/portal

# Set env vars
export OP_SERVICE_ACCOUNT_TOKEN=<token>
export OP_VAULT_NAME=Kairikos
export DATABASE_URL=<your postgres url>

# Dry run: just verify the 1Password read works
npx tsx scripts/rotate-secret.ts portal_api_key
```

Expected: the script generates a new key, writes it to 1Password, and updates the
running container.

---

## Step 6 — Schedule the Service Account token rotation (90-day reminder)

The Service Account token itself expires according to your 1Password plan.
Set a calendar reminder or a Paperclip routine to rotate it every **90 days**.

To rotate the token:
1. 1Password → Manage Vaults → Service Accounts → kairikos-rotate-worker → Regenerate.
2. Update the `OP_SERVICE_ACCOUNT_TOKEN` in your VPS env.
3. Restart the portal container: `docker restart kairikos-portal-app-1`.

---

## Integration-specific notes

| toolKey | Rotation method | Manual step required? |
|---------|----------------|----------------------|
| `portal_api_key` | Auto — worker generates new 32-byte hex key | No |
| `postgres_password` | Auto — worker generates new 24-char password | Yes — must also update Postgres `ALTER USER` and docker-compose env |
| `resend` | Manual — Resend has no rotate API | Yes — create new key at resend.com/api-keys |
| `n8n` | Manual — n8n has no rotate API | Yes — regenerate via n8n UI Settings |

For `resend` and `n8n`, the worker logs the manual steps and exits with an error
code. After the operator completes the manual step, re-run the worker to write
the new value to 1Password and update the container.

---

## Secure-handoff pattern (per KAIA-1591)

> **Why this section exists:** the previous pattern was to paste a service role
> key into a Paperclip issue, an agent adapter env, or a chat log. The blast
> radius of a service role key is "full DB read/write for the entire Supabase
> project" — there is no way to unsend a Paperclip comment. **Never do that.**

The 1Password Service Account set up in Step 1 also enables a *retrieval-time*
pattern: the agent that needs the secret stores only an `op://` reference
(env var ending in `_OP_REF`) plus the vault name, and calls `op read` at the
moment of use. The plain secret value never appears in the agent's adapter
config, in any Paperclip issue, or in any chat log.

### Naming convention

| Env var in the agent adapter | Example value |
|------------------------------|---------------|
| `<SERVICE>_OP_REF` | `op://Kairikos/<item-name>/<field>` |
| `OP_VAULT_NAME` | `Kairikos` |

### Retrieval pattern (shell, before the script that needs the secret)

```bash
export SUPABASE_SERVICE_ROLE_KEY=$(op read "$SUPABASE_SERVICE_ROLE_KEY_OP_REF")
psql "$SUPABASE_DB_URL" -f supabase/seeds/chatbot_clients_seed.sql
```

### Items to add to the Kairikos vault for QA smoke runs

| Item name | Field | Source | Owner |
|-----------|-------|--------|-------|
| `Supabase — QA seed (project-fxidg)` | `credential` (sensitive) | CTO pastes the existing service role JWT once at item creation | CTO |
| same | `project_ref` | `ikexqreuvoqwvwopftkt` | CTO |
| same | `url` | `https://ikexqreuvoqwvwopftkt.supabase.co` | CTO |
| same | `purpose` | `QA seed for KAIA-1272 / KAIA-1590` | CTO |

The Service Account from Step 1 has read access. The Founding Engineer
(operator of `op` on the VPS) has write access to add new items.

### What never goes in an issue / chat / adapter env

- The service role JWT itself (only `op://...` references and item *names*).
- A plaintext DB password or connection string.
- A Vercel token (rotate instead, separate issue).
- A Google API key (use a scoped service account JSON in 1Password, not the key string).

If a future request asks for a secret to be "just pasted into a comment for
speed," refuse and route through this runbook instead. The CEO will approve the
extra 5 minutes; a leaked service role key costs the entire project.

---

## Troubleshooting

**`op: command not found`**
→ Install the 1Password CLI (Step 4). Verify with `which op`.

**`Failed to read current secret from 1Password`**
→ Verify the Service Account has access to the vault (Step 1, item 5).
→ Verify the item name and field match the table in Step 3.

**`docker exec env update failed`**
→ The container may not be named `kairikos-portal-app-1`. Check with:
  `docker ps --format '{{.Names}}'`
  Update the `dockerRestart()` call in `scripts/rotate-secret.ts` if the name differs.

**` OperatorSettings.lastRotatedAt updated` does not appear**
→ Set `DATABASE_URL` env var so the worker can reach Prisma.