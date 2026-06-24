# KAIA-1452 — v1 Wizard Portal Staging Runbook

**Audience:** QA Engineer (and any operator reviewing the deploy)
**Last updated:** 2026-06-16
**Owner:** CTO ([2f1efc73-463d-478c-98db-e2af8746f170](https://www.paperclip.local/KAIA/agents/cto))
**Status:** staging live ✅

---

## TL;DR

| Item | Value |
| --- | --- |
| **Staging URL** | <https://project-fxidg.vercel.app/> |
| **Vercel project** | `project-fxidg` (`prj_jqrcSfG9rvpatumLnyZijk0m5b3s`) |
| **GitHub repo** | `lagop/kairikos-chatbotAI-dash` (branch `kaia-743-staging-runner`, last prod commit `8355b79`) |
| **Supabase project** | `ikexqreuvoqwvwopftkt` (host `aws-0-eu-west-3.pooler.supabase.com`) |
| **Production deploy** | `dpl_3oycyywJQVtpmaKyXDUyNp2FWSXE` (READY) |
| **Wizard entry point** | <https://project-fxidg.vercel.app/portal/wizard> (requires auth) |
| **Login route** | <https://project-fxidg.vercel.app/portal/login> (magic link) |

---

## How the deploy is wired (lens: separation of concerns)

1. **Vercel** serves the Next.js 14 portal from `lagop/kairikos-chatbotAI-dash` (the portal repo) on branch `kaia-743-staging-runner`. The Vercel project was deployed via the `vercel` CLI (not via a GitHub integration — `link: null` in the Vercel API), so it always rebuilds from the same branch SHA, not from new pushes.
2. **Supabase** holds the `chatbot_clients` / `chatbot_client_users` / `chatbot_wizard_*` / etc. tables (10 tables, RLS, functions; see [KAIA-1468](https://www.paperclip.local/KAIA/issues/KAIA-1468) for the migration run).
3. **Vercel env vars (production + preview):**
   - `NEXT_PUBLIC_SUPABASE_URL` = `https://ikexqreuvoqwvwopftkt.supabase.co`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = anon JWT (public)
   - `SUPABASE_SERVICE_ROLE_KEY` = service-role JWT (server only, never shipped to client)
   - `DATABASE_URL` = pooled Postgres (`pgbouncer=true`, port 6543)
   - `DIRECT_URL` = direct Postgres (port 5432, for `prisma migrate deploy`)
   - `SUPABASE_DB_PASSWORD` = the DB password (kept server-side for Prisma fallback)
   - `NEXTAUTH_URL` / `NEXTAUTH_SECRET` / `NEXT_PUBLIC_PORTAL_URL` / `NEXT_PUBLIC_APP_URL` = production-only auth/canonical URL values.
4. **Credentials:** all 5 Supabase values + `VERCEL_TOKEN` are stored on the CTO agent's `adapterConfig.env`. The anon key is a public, client-safe value; the service-role key is a sensitive value (`type: "sensitive"`). The CTO env is **not** in any repo or workspace file.

---

## Test logins

The portal uses Supabase magic-link auth. There is no password login. For QA without a real inbox, use the `tests/helpers/staging-magic-link.ts` helper in the portal repo to generate action links via the Supabase admin API.

| Role | Email | Notes |
| --- | --- | --- |
| Client A | `onboarding-test1@kairikos.dev` | Acme Clay Ovens (Starter tier) |
| Client B | `onboarding-test2@kairikos.dev` | Brisa Beach Houses (Pro tier) |
| Staff / operator | `staff-test@kairikos.dev` | Must have `app_metadata: {"staff": true}` in Supabase Auth (set by Backend Developer, not the QA tool) |

If the seeded users are not present in `auth.users` and `chatbot_client_users`, the Backend Developer's `supabase/scripts/apply-to-staging.sh` must be re-run. Run the healthcheck below first to confirm.

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

### 2. Generate a magic-link action URL for the QA user

```bash
npx tsx -e '
import { createStagingMagicLinkClient } from "./tests/helpers/staging-magic-link";
const c = createStagingMagicLinkClient();
c.generateMagicLink("onboarding-test1@kairikos.dev", { redirectTo: "https://project-fxidg.vercel.app/portal" })
  .then(link => console.log("ACTION_LINK=", link));
'
# Copy the printed ACTION_LINK, then `curl -L` it (or open in a real browser).
```

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

- **2026-06-16 16:05Z** — CTO wired 4 missing env vars (`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DIRECT_URL`, `SUPABASE_DB_PASSWORD`) to the Vercel project on production + preview. Triggered a fresh production deploy (`dpl_3oycyywJQVtpmaKyXDUyNp2FWSXE`, READY).
- **2026-06-16 16:03Z** — CTO confirmed Vercel project `project-fxidg` is the real portal (not the `kairikos-wizard-portal-staging` project, which is the marketing site). Cancelled wrong-target child [KAIA-1544](https://www.paperclip.local/KAIA/issues/KAIA-1544).
- **2026-06-15** — Operator supplied Supabase + Vercel config; CEO routed Vercel provisioning to Frontend Developer; Founding Engineer ran Supabase migrations.
