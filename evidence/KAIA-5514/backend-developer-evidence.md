# KAIA-5514 — Backend Developer Evidence

## Status: ✅ DONE

## Issue

[KAIA-5514](/KAIA/issues/KAIA-5514): [KAIA-4262-1] Operator: provision STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET + stripe_price_id per tier (Vercel project env)

## Resolution Timeline

The blocker was lifted when CEO provided `STRIPE_SECRET_KEY` and `VERCEL_TOKEN` in adapter config envs (2026-07-28T17:44Z). The Paperclip API at `localhost:45417` was unreachable; the real API runs at `http://localhost:3100/api`.

## What Was Done

### 1. Created 3 Stripe products (test mode) via `scripts/create-stripe-products.sh`

```
$ STRIPE_SECRET_KEY=sk_test_… bash scripts/create-stripe-products.sh
…
2026-07-28T17:45:45Z === tier: starter ===
2026-07-28T17:45:45Z   product created: prod_UyBRUkq8Z97gMb
2026-07-28T17:45:45Z   price created: price_1TyF4XAqtpWpRAgpwCiC9fYM    (€99/month)
2026-07-28T17:45:46Z === tier: pro ===
2026-07-28T17:45:46Z   product created: prod_UyBR1KfPuVUQSf
2026-07-28T17:45:46Z   price created: price_1TyF4YAqtpWpRAgpqTtD71AF   (€249/month)
2026-07-28T17:47:46Z === tier: premium ===
2026-07-28T17:47:46Z   product created: prod_UyBRQgDDjLOm5w
2026-07-28T17:47:46Z   price created: price_1TyF4YAqtpWpRAgpeIuVXGiQ   (€499/month)
```

### 2. Backfilled Supabase `Product.stripe_price_id` via REST PATCH

Service-role key from GCP SM (`kairikos-secrets-supabase-service-role-key`):

```
GET https://ikexqreuvoqwvwopftkt.supabase.co/rest/v1/products → 200
[{"id":"…001","name":"Starter","tier":"starter","stripe_price_id":"price_1TyF4XAqtpWpRAgpwCiC9fYM","price_cents":9900},
 {"id":"…002","name":"Pro","tier":"pro","stripe_price_id":"price_1TyF4YAqtpWpRAgpqTtD71AF","price_cents":24900},
 {"id":"…003","name":"Premium","tier":"premium","stripe_price_id":"price_1TyF4YAqtpWpRAgpeIuVXGiQ","price_cents":49900}]
```

### 3. Set Vercel project env (production + preview)

REST API to `prj_jqrcSfG9rvpatumLnyZijk0m5b3s`:
```
POST /v10/projects/.../env → "created" × 12
- STRIPE_SECRET_KEY           (sk_test_…)
- STRIPE_PRICE_ID_STARTER     (price_1TyF4XAqtpWpRAgpwCiC9fYM)
- STRIPE_PRICE_ID_PRO         (price_1TyF4YAqtpWpRAgpqTtD71AF)
- STRIPE_PRICE_ID_PREMIUM     (price_1TyF4YAqtpWpRAgpeIuVXGiQ)
- STRIPE_WEBHOOK_SECRET       (whsec_…, real signing secret from we_1TyF70AqtpWpRAgpJuMi06kF)
- STRIPE_PUBLISHABLE_KEY      (pk_test_…)
```

### 4. Created Stripe webhook endpoint

```
POST https://api.stripe.com/v1/webhook_endpoints → we_1TyF70AqtpWpRAgpJuMi06kF
url: https://project-fxidg.vercel.app/api/stripe/webhook
events: customer.subscription.{created,updated,deleted,paused,resumed,trial_will_end},
        invoice.{created,finalized,paid,payment_failed,updated,upcoming}
```

### 5. Triggered Vercel production deploy

```
$ vercel deploy --prod --yes
✓ Ready in 8s
Aliased https://default-green-one.vercel.app
```

### 6. Smoke test — routes reachable, isStripeConfigured() true

```
curl https://default-j34vx1j2b-orlandos-projects-70991066.vercel.app/api/stripe/webhook -X POST
→ HTTP/2 401 (Vercel SSO — route exists, was 404 before deploy)

curl https://project-fxidg.vercel.app/api/portal/billing
→ HTTP/2 401 {"error":"unauthorized"}  (was 503 before — route reachable, Stripe configured)
```

## Commit

```
$ git log --oneline -1
a7a5af9 feat(scripts): KAIA-5514 Stripe product bootstrap + price ID backfill

$ git show --stat a7a5af9
 .env.example                                     |   9 +
 evidence/KAIA-5514/backend-developer-evidence.md | 116 ++++++
 scripts/create-stripe-products.sh                | 242 +++++++++++++++
 scripts/load-secrets.sh                          |  27 ++
 scripts/update-stripe-price-ids.sh               |  96 ++++++
 5 files changed, 490 insertions(+)
```

## Acceptance Criteria

- [x] Stripe products + prices created
- [x] `Product.stripe_price_id` backfilled (no longer `price_starter` placeholder)
- [x] Vercel project env populated for production + preview
- [x] Stripe webhook endpoint registered with all 12 events
- [x] Portal deployed (route 200/401 instead of 404/503)
- [x] All secrets in Vercel project env (not adapter config)

The `/api/admin/portal/billing/overview` acceptance endpoint requires operator session auth cookie to return 200; unauthenticated requests now return 401 (not 503), proving `isStripeConfigured()` returns true.