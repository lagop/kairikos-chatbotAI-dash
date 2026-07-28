# KAIA-5514 — Backend Developer Evidence

## Status: BLOCKED — cannot complete without Stripe API key

## CEO Question

> "Cant you create the 3 products in Stripe?" (2026-07-28T17:07:30.781Z)

**Answer: No. Here is why:**

I have no Stripe API key. I audited every possible source:

| Source | Available? | Details |
|--------|-----------|---------|
| Environment vars | ❌ | No `STRIPE_SECRET_KEY` or `sk_test_`/`sk_live_` prefix |
| GCP Secret Manager | ❌ | `gcloud secrets list --project=kairikos` — no `stripe-secret-key` exists |
| Vercel project env | ❌ | No `VERCEL_TOKEN` in GCP SM; `vercel whoami` → not logged in |
| Workspace `.env` | ❌ | Contains only Supabase URL/keys, no Stripe |
| Stripe CLI | ❌ | Not installed; `npm install -g @stripe/stripe-cli` → 404 |
| Stripe SDK | ✅ (installed) | npm package installed but unusable without API key |

GCP SM authenticated as: `kairikos-secret-provisioner@kairikos.iam.gserviceaccount.com`

## Supabase Database — Current Product State (confirmed via REST API)

Queried `https://ikexqreuvoqwvwopftkt.supabase.co/rest/v1/products` with service-role key:

| tier | stripe_price_id (current) | price_cents |
|------|--------------------------|-------------|
| starter | `price_starter` (PLACEHOLDER) | 9900 |
| pro | `price_pro` (PLACEHOLDER) | 24900 |
| premium | `price_premium` (PLACEHOLDER) | 49900 |

The `stripe_price_id` values are the literal placeholder strings from the DB seed — **not real Stripe price IDs**. These will cause Stripe subscription creation to fail. They must be replaced with real `price_xxx` IDs from the Stripe dashboard.

GCP SM secrets confirmed:
```
kairikos-secrets-dashboard-webhook-shared-secret
kairikos-secrets-n8n-relay-base-url
kairikos-secrets-n8n-relay-token
kairikos-secrets-slack-error-webhook-url
kairikos-secrets-supabase-project-ref
kairikos-secrets-supabase-service-role-key
```
**No stripe-secret-key, no vercel-token.**

## Scripts Ready (agent-side work COMPLETE)

1. **`scripts/create-stripe-products.sh`** — idempotent curl-based Stripe REST API client
   - Creates 3 products (Starter €99, Pro €249, Premium €499/month EUR)
   - Idempotent: skips create if `metadata[kairikos_tier]` product exists
   - Emits JSON + shell exports with `price_xxx` IDs
   - Syntax verified (`bash -n`)
   - **Needs**: `STRIPE_SECRET_KEY` in environment

2. **`scripts/update-stripe-price-ids.sh`** — backfills `Product.stripe_price_id` in Supabase
   - psql transaction with verification query
   - Validates `price_xxx` format
   - **Needs**: `STRIPE_PRICE_ID_STARTER/PRO/PREMIUM` + `SUPABASE_DB_URL`

3. **`scripts/load-secrets.sh`** — updated with Stripe materialisation
   - Pulls `STRIPE_SECRET_KEY` from GCP SM at `kairikos-secrets/stripe-secret-key`
   - Pulls `STRIPE_WEBHOOK_SECRET` from GCP SM at `kairikos-secrets/stripe-webhook-secret`
   - **Needs**: operator provisions the secrets first

4. **`.env.example`** — `STRIPE_PRICE_ID_STARTER/PRO/PREMIUM` documented

## Unblock Actions (operator/CEO)

### Path A: Provision in GCP SM (enables full agent automation)

```bash
# 1. Store Stripe secret key
#    Paste the secret key value from 1Password or the Stripe Dashboard.
gcloud secrets create stripe-secret-key --project=kairikos --replication-policy=automatic
printf '%s' "<STRIPE_SECRET_KEY>" | \
  gcloud secrets versions add stripe-secret-key --project=kairikos --data-file=-

# 2. Store Stripe webhook signing secret (from Stripe dashboard → Webhooks)
#    Paste the signing secret value from 1Password or the Stripe Dashboard.
gcloud secrets create stripe-webhook-secret --project=kairikos --replication-policy=automatic
printf '%s' "<STRIPE_WEBHOOK_SECRET>" | \
  gcloud secrets versions add stripe-webhook-secret --project=kairikos --data-file=-

# 3. Agent then runs:
#    source scripts/load-secrets.sh
#    eval "$(scripts/create-stripe-products.sh)"
#    scripts/update-stripe-price-ids.sh
```

### Path B: Manual Stripe dashboard (no agent involvement)

1. Go to Stripe dashboard → Products → New
2. Create Starter (€99/month EUR), Pro (€249/month EUR), Premium (€499/month EUR)
3. Copy each product's default `price_xxx`
4. Set in Vercel project env: `STRIPE_PRICE_ID_STARTER=price_xxx STRIPE_PRICE_ID_PRO=price_yyy STRIPE_PRICE_ID_PREMIUM=price_zzz`
5. Run `scripts/update-stripe-price-ids.sh`

## Acceptance Criteria

- `curl https://portal.kairikos.example.com/api/admin/portal/billing/overview` returns 200 (not 503)
- `scripts/verify-stripe-webhook.sh` exits 0 with `stripe_event_id=evt_…`
- All 3 Product rows have `stripePriceId` set

## Paperclip API Status (RESOLVED 2026-07-28)

`localhost:45417` and `http://72.62.53.68:3100` were both unreachable initially.
**CEO hint resolved the API access** (`You have paperclip api url in your adapter config envs: http://localhost:45417/api`).
The PAPERCLIP_API_URL env points to port 45417 which has no server. Discovered the real Paperclip API runs at `http://localhost:3100/api` (confirmed via `/api/health` → `{"status":"ok","deploymentMode":"authenticated","bootstrapStatus":"ready"}`).

Fix: prefix helper invocations with `PAPERCLIP_API_URL=http://localhost:3100/api`.

## Final Disposition

**Issue updated to `blocked`** via PATCH (2026-07-28T17:18Z) — first-class blocker: no Stripe API key exists anywhere the agent can access.
Owner to unblock: **Operator/CEO** (provision `stripe-secret-key` in GCP SM at `kairikos-secrets/stripe-secret-key`).

Status update also posted via Paperclip API helper (comment id `0f1b3d32-…`).