# KAIA-1452 — v1 Wizard Portal Staging Runbook

**Audience:** QA Engineer (and any operator reviewing the deploy)
**Last updated:** 2026-08-11
**Owner:** CTO ([2f1efc73-463d-478c-98db-e2af8746f170](https://www.paperclip.local/KAIA/agents/cto))
**Status:** staging live ✅

---

## TL;DR

| Item | Value |
| --- | --- |
| **Staging URL** | <https://project-fxidg.vercel.app/> |
| **Vercel project** | `project-fxidg` (`prj_jqrcSfG9rvpatumLnyZijk0m5b3s`) |
| **GitHub repo** | `lagop/kairikos-chatbotAI-dash` (branch `kaia-743-staging-runner`, last prod commit `0cf9a4ac`) |
| **Supabase project** | `ikexqreuvoqwvwopftkt` (host `aws-0-eu-west-3.pooler.supabase.com`) |
| **Production deploy** | `dpl_34vwVPATkk7jKmPhipuMTwYC3gXi` (READY, PROMOTED) |
| **Wizard entry point** | <https://project-fxidg.vercel.app/portal/wizard> (requires auth) |
| **Login route** | <https://project-fxidg.vercel.app/portal/login> (credentials — email + password, since KAIA-2103) |

---

## How the deploy is wired (lens: separation of concerns)

1. **Vercel** serves the Next.js 14 portal from `lagop/kairikos-chatbotAI-dash` (the portal repo). The deploy is Git-driven: Vercel's GitHub integration is configured with the production branch set to `kaia-743-staging-runner`. A push to that branch triggers a Vercel build; changing the Production Branch setting does **not** retroactively deploy the current SHA — a new commit or an explicit Redeploy from the Vercel dashboard is required to go live (per [KAIA-2809](https://www.paperclip.local/KAI/issues/KAIA-2809)). After any Production Branch change, verify the deploy is live via `curl -s https://api.github.com/repos/lagop/kairikos-chatbotAI-dash/deployments | jq '.[0] | {sha, environment, created_at}'` before accepting the claim.
2. **Supabase** holds the `chatbot_clients` / `chatbot_client_users` / `chatbot_wizard_*` / etc. tables (10 tables, RLS, functions; see [KAIA-1468](https://www.paperclip.local/KAIA/issues/KAIA-1468) for the migration run).
3. **Vercel env vars (production + preview):**
   - `NEXT_PUBLIC_SUPABASE_URL` = `https://ikexqreuvoqwvwopftkt.supabase.co`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = anon JWT (public)
   - `SUPABASE_SERVICE_ROLE_KEY` = service-role JWT (server only, never shipped to client)
   - `DATABASE_URL` = pooled Postgres (`pgbouncer=true`, port 6543)
   - `DIRECT_URL` = direct Postgres (port 5432, for `prisma migrate deploy`)
   - `SUPABASE_DB_PASSWORD` = the DB password (kept server-side for Prisma fallback)
   - `NEXTAUTH_URL` / `NEXTAUTH_SECRET` / `NEXT_PUBLIC_PORTAL_URL` / `NEXT_PUBLIC_APP_URL` = production-only auth/canonical URL values.
4. **Credentials:** the 5 Supabase values are stored in the CTO agent's `adapterConfig.env` (Option A — provider-native secret store). `VERCEL_TOKEN` is not stored in any agent adapter; Vercel project env handles it. The anon key is a public, client-safe value; the service-role key is a sensitive value (`type: "sensitive"`). No credentials are in any repo or workspace file.

---

## Test logins

The portal uses **email + password credentials** auth (KAIA-2103). The previous Supabase magic-link flow is no longer wired into `auth.ts` — only two Credentials providers exist (`portal-credentials` for client users, `admin-credentials` for operators). The password hash lives in `prisma.User.passwordHash` and `prisma.Operator.passwordHash` (PostgreSQL via Supabase). For QA:

1. **Set `STAGING_TEST_USER_PASSWORD`** in the portal `.env` (canonical name — see `portal/.env.example`, KAIA-2900). The same env var is read by the seed script and by `tests/fixtures/portal.ts:authedPortalFixture` so the Playwright spec and the seed agree by construction. The QA agent's `scripts/load-secrets.sh` sources it from `.env`.
2. **Run `portal/scripts/seed-test-passwords.ts`** (via `apply-to-staging.sh` Step 5, or directly with `npx tsx`) to write a fresh argon2id hash on the three client test users. Idempotent.
3. **Sign in at** <https://project-fxidg.vercel.app/portal/login> (client) or `/admin/login` (operator).

| Role | Email | Notes |
| --- | --- | --- |
| Client A | `onboarding-test1@kairikos.dev` | Acme Clay Ovens (Pro tier) |
| Client B | `onboarding-test2@kairikos.dev` | Brisa Beach Houses (Starter tier) |
| Staff / operator (client) | `staff-test@kairikos.dev` | `User.role='client'`; logs in at `/portal/login` |
| Operator | `ops-staging@kairikos.com` | `Operator` table; logs in at `/admin/login` via `admin-credentials` |

If the seeded users are not present in `auth.users` / `chatbot_client_users` / `User`, re-run the Backend Developer's `supabase/scripts/apply-to-staging.sh`. Step 5 (KAIA-2900) refreshes the client `passwordHash`; Step 4 ensures `auth.users` exists. The operator row is seeded separately via `portal/scripts/seed-staging-operator.ts` (KAIA-1585).

---

## Smoke-test commands for [KAIA-1174](https://www.paperclip.local/KAIA/issues/KAIA-1174)

### 0. Cold-load check (start of every run)

```bash
curl -s -o /dev/null -w "Status: %{http_code} | Time: %{time_total}s\n" \
  -L "https://project-fxidg.vercel.app/portal"
# Expected: 200, < 2s for the first cold load
```

### 1. Healthcheck the Supabase staging DB

From the CTO env (run in a heartbeat that has `SUPABASE_SERVICE_ROLE_KEY`):

```bash
cd /paperclip/instances/default/projects/fe217b5c-badf-4f17-ab20-f089478a35c7/bbe7754b-a8a8-4e1d-86b6-8cbbc4cfa3a4/_default/portal
# Pull the 3 required vars from the CTO env
export SUPABASE_URL="https://ikexqreuvoqwvwopftkt.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY"
export PORTAL_URL="https://project-fxidg.vercel.app"
# Healthcheck
npx tsx -e '
import { createStagingMagicLinkClient } from "./tests/helpers/staging-magic-link";
const c = createStagingMagicLinkClient();
c.healthcheck().then(r => console.log(JSON.stringify(r, null, 2)));
'
# Expected: { ok: true, authUserCount >= 2, clientCount >= 2, issues: [] }
```

### 2. Confirm the seeded client test users have a known passwordHash (KAIA-2900)

The portal now uses email + password (`portal-credentials` provider) — not magic-link. Before running any spec that drives an authenticated UI, the three client test users must have a real argon2id hash in `User.passwordHash`. Two equivalent ways to set it:

```bash
# Path A — re-run the staging runner (covers migrations, seed, auth.users, and passwords).
./supabase/scripts/apply-to-staging.sh

# Path B — passwords only (skip the SQL + smoke if they already ran this hour).
cd portal
SUPABASE_URL="https://ikexqreuvoqwvwopftkt.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
STAGING_TEST_USER_PASSWORD="$STAGING_TEST_USER_PASSWORD" \
  npx tsx scripts/seed-test-passwords.ts
# Expected (3 rows, all "OK … password refreshed" or "User row created"):
#   [seed-test-passwords] OK onboarding-test1@kairikos.dev — password refreshed (id …)
#   [seed-test-passwords] OK onboarding-test2@kairikos.dev — password refreshed (id …)
#   [seed-test-passwords] OK staff-test@kairikos.dev — password refreshed (id …)
```

Sanity-check the hash prefix from the Supabase SQL editor:

```sql
select email, substring("passwordHash" for 10) as hash_prefix, "passwordSetAt" is not null as has_set_at
from "User"
where email in ('onboarding-test1@kairikos.dev', 'onboarding-test2@kairikos.dev', 'staff-test@kairikos.dev');
```

**Expected:** three rows, every `hash_prefix` = `$argon2id$`, every `has_set_at` = `true`.

The QA agent's `scripts/load-secrets.sh` must source `STAGING_TEST_USER_PASSWORD` from the project `.env` into the runtime before the Playwright `authedPortalFixture` runs; otherwise the fixture's `portal-credentials` POST returns `302 → /portal/login?error=CredentialsSignin`.

### 3. Wizard happy-path per vertical

Per [KAIA-1254](https://www.paperclip.local/KAIA/issues/KAIA-1254), [KAIA-1255](https://www.paperclip.local/KAIA/issues/KAIA-1255), [KAIA-1257](https://www.paperclip.local/KAIA/issues/KAIA-1257), [KAIA-1258](https://www.paperclip.local/KAIA/issues/KAIA-1258):

- Starter client: log in as `onboarding-test1@kairikos.dev`, drive the wizard through all visible steps end-to-end, verify autosave, submit, have an operator approve each step, verify the global state machine, verify the bot goes live in n8n with the right config (at least `canal_web`), verify the abandoned-wizard trigger fires for a client who stops after Step 2, verify the cohort funnel counts the right number.
- Pro client: repeat for `onboarding-test2@kairikos.dev`.
- Per vertical: repeat the two-tier run.

### 4. Vitest tier-visibility + Playwright happy-path

[KAIA-1523](https://www.paperclip.local/KAIA/issues/KAIA-1523) is the Playwright + Vitest coverage for tier-aware step visibility. Run from the portal repo:

```bash
cd /paperclip/instances/default/projects/fe217b5c-badf-4f17-ab20-f089478a35c7/bbe7754b-a8a8-4e1d-86b6-8cbbc4cfa3a4/_default/portal
# Vitest
npx vitest run tests/specs/
# Playwright (uses PORTAL_URL=https://project-fxidg.vercel.app)
PORTAL_URL="https://project-fxidg.vercel.app" npx playwright test --reporter=line
```

---

## What is **not** in scope for this run (lens: incremental delivery)

- **Custom domain `portal.kairikos.com`** — deferred. The Vercel preview/production URL is the staging target.
- **Production-hardening (WAF, autoscaling, RLS audits beyond v1 minimum)** — deferred to [KAIA-1252](https://www.paperclip.local/KAIA/issues/KAIA-1252).
- **Implementing the wizard steps themselves** — those are owned by the Frontend Developer / Backend Developer / Automation Engineer and are already `done` (KAIA-1166, 1168, 1169, 1170, 1172, 1177).

---

## Failure modes and first-line recovery

| Symptom | Likely cause | First action |
| --- | --- | --- |
| Cold load returns 5xx | Supabase auth or DB outage | Check `https://ikexqreuvoqwvwopftkt.supabase.co/auth/v1/health` and the Supabase status page |
| `/portal/login` renders but `generateLink` returns 404 on the user | Seed users not in `auth.users` | Re-run Backend Developer's `supabase/scripts/apply-to-staging.sh` |
| Wizard submits but `canal_web` n8n bot never goes live | Missing `PORTAL_API_KEY` in Vercel env | CTO to wire `PORTAL_API_KEY` as Vercel env var (see follow-up below) |
| Cross-tenant leak in Playwright | RLS policy gap | File a follow-up issue under [KAIA-1171](https://www.paperclip.local/KAIA/issues/KAIA-1171) — owned by Backend Developer |

---

## Follow-ups (deferred, not blocking QA)

- **PORTAL_API_KEY on Vercel:** the portal's internal `/api/internal/*` routes (used by n8n T+0/3/7/14 workflows + the status-change watcher) require a shared secret. This is not in the Vercel env yet. CTO to wire the same value the n8n vault has under `PORTAL_API_KEY` once the operator confirms the n8n value. Tracked as part of [KAIA-1252](https://www.paperclip.local/KAIA/issues/KAIA-1252) rollout.
- **Custom domain + DNS** (deferred until smoke passes).
- **Operator-side dashboard** for the v1 wizard — already done at [KAIA-1169](https://www.paperclip.local/KAIA/issues/KAIA-1169) (per-step review UI).

---

## Change log

- **2026-08-11** — CEO reconciled [KAIA-13765](/KAI/issues/KAIA-13765) and [KAIA-14024](/KAI/issues/KAIA-14024): discovered that `link.productionBranch` was still set to `main` in the Vercel Git-link config (STAGING.md always claimed `kaia-743-staging-runner`, and the actual `targets.production` was already serving a recent `kaia-743-staging-runner` HEAD `0cf9a4ac` — so the visible portal was correct, but the auto-deploy target for future pushes was wrong). The current production deploy `dpl_3oycyywJQVtpmaKyXDUyNp2FWSXE` (KAIA-2790) was superseded by `dpl_34vwVPATkk7jKmPhipuMTwYC3gXi` (KAIA-13797 deploy). Production-branch flip on the Vercel side requires the Vercel dashboard — the Vercel REST API does not expose `link.productionBranch` as a writable field. Operator (or, with explicit approval, a future CTO run) must complete that dashboard edit. The exact dashboard sequence is **Project Settings → Environments → Production → Branch Tracking → change branch from `main` to `kaia-743-staging-runner` → Save** (per the Vercel docs at vercel.com/docs/git#customizing-the-production-branch; the older Settings → Git path is not the current UI). The production target is already correct in the meantime.
- **2026-07-01** — CTO scrubbed `VERCEL_TOKEN` from CTO adapter (Option A — provider-native secret store; no agent holds the token). Updated deploy wiring description from `vercel` CLI to Git-driven with explicit Vercel Production Branch change + mandatory post-Save Redeploy verification step (KAIA-2790/KAIA-2788).
- **2026-06-16 16:05Z** — CTO wired 4 missing env vars (`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DIRECT_URL`, `SUPABASE_DB_PASSWORD`) to the Vercel project on production + preview. Triggered a fresh production deploy (`dpl_3oycyywJQVtpmaKyXDUyNp2FWSXE`, READY).
- **2026-06-16 16:03Z** — CTO confirmed Vercel project `project-fxidg` is the real portal (not the `kairikos-wizard-portal-staging` project, which is the marketing site). Cancelled wrong-target child [KAIA-1544](https://www.paperclip.local/KAIA/issues/KAIA-1544).
- **2026-06-15** — Operator supplied Supabase + Vercel config; CEO routed Vercel provisioning to Frontend Developer; Founding Engineer ran Supabase migrations.
