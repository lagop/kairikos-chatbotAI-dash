# Runbook — KAIA-735: portal.kairikos.com DNS + Supabase magic-link sender

> **⚠ SUPERSEDED — DO NOT FOLLOW.** This runbook was written for plan
> rev 2 (Supabase Auth + Vercel deploy of the marketing project). The
> CTO cancelled [KAIA-735](/KAIA/issues/KAIA-735) on 2026-06-10 and
> replaced the architecture with plan rev 3 (Prisma + PostgreSQL on a
> Docker VPS + NextAuth.js v5 magic-link + Resend). The replacement
> children — [KAIA-752](/KAIA/issues/KAIA-752) (Prisma schema),
> [KAIA-753](/KAIA/issues/KAIA-753) (NextAuth + Resend),
> [KAIA-754](/KAIA/issues/KAIA-754) (Docker VPS deploy),
> [KAIA-755](/KAIA/issues/KAIA-755) (Portal Next.js API + UI) — are
> all `done`. The portal frontend now lives in `portal/` (Next.js on
> the VPS), not on Vercel. This file is kept as a historical record of
> the rev 2 architecture decision only.
>
> For the current portal deploy, see `docker-compose.yml` (KAIA-754)
> and `portal/README.md` § Deploy.

> **Audience (historical):** the operator who held the domain registrar
> and the Supabase owner login under plan rev 2.

**Issue:** [KAIA-735](/KAIA/issues/KAIA-735) (cancelled 2026-06-10)
**Architecture decision (CTO):** `portal.kairikos.com` is added as a
**new domain on the existing kairikos.com Vercel project** — not a new
dedicated Vercel project. Recorded on the issue in the
"CTO architecture decision" comment. Reversible: DNS repoint + Vercel
project reassignment, no code changes.

**Why this runbook is durable:** the operator is the only one who can
apply the registrar change and confirm the Supabase sender; this file
captures both, plus the post-change verification.

---

## TL;DR

1. **Vercel** → open the **kairikos** project → Settings → Domains →
   add `portal.kairikos.com`. Note the exact CNAME target Vercel
   displays.
2. **Operator** → registrar for `kairikos.com` → add a CNAME:
   - Host: `portal`
   - Target: the value from Vercel (typically `cname.vercel-dns.com` —
     verify against Vercel's display)
   - TTL: `Auto` or `300`
3. **Wait** for DNS to propagate (`dig portal.kairikos.com CNAME +short`).
4. **Operator** → Supabase → Authentication → Email Templates → Sender
   → confirm sending address is on a warmed-up Kairikos domain
   (`noreply@kairikos.com`). Confirm Site URL is
   `https://portal.kairikos.com` and the redirect allowlist includes
   `https://portal.kairikos.com/api/auth/callback`.
5. **Verify** with a real magic-link send — must land in primary inbox
   within 30 seconds.

---

## Step 1 — Vercel: confirm the project target

1. Log into Vercel as the Kairikos account.
2. Open the **kairikos** project (the one already deployed at
   `kairikos.com`).
3. Go to **Settings → Domains**.
4. Confirm `portal.kairikos.com` is not already listed. If it is,
   remove it first.
5. Click **Add** → enter `portal.kairikos.com`.
6. Vercel displays the exact CNAME target it expects. **Copy that
   value** — it can differ from `cname.vercel-dns.com` if Vercel is
   routing through a per-project front.
7. Do not yet mark the domain as primary. The portal frontend lives
   under `/portal/*`, the marketing site owns the apex.

### Vercel env vars (this project)

Per the CTO decision, portal env vars live in the **same** Vercel
project and are namespaced with a `PORTAL_` prefix to distinguish them
from marketing vars.

| Env var | Scope | Purpose |
| --- | --- | --- |
| `PORTAL_SUPABASE_URL` | Production, Preview | Supabase project URL (same as `NEXT_PUBLIC_SUPABASE_URL`) |
| `PORTAL_SUPABASE_ANON_KEY` | Production, Preview | Supabase anon key — the portal's `@supabase/ssr` client uses this |
| `PORTAL_SUPABASE_SERVICE_ROLE_KEY` | Production, Preview | Server-only, for the `/api/portal/login` route and any backend service that needs to bypass RLS |
| `PORTAL_API_BASE_URL` | Production | NestJS portal API (`https://api.kairikos.com` in prod) |
| `PORTAL_SITE_URL` | Production | `https://portal.kairikos.com` — used for OG canonical and the magic-link `emailRedirectTo` base |
| `PORTAL_REDIRECT_ALLOWLIST` | Production | Comma-separated; must include `https://portal.kairikos.com/api/auth/callback` |

Frontend code reads the `NEXT_PUBLIC_*` aliases; Vercel maps them to
the `PORTAL_*` values in the project env. (If the repo is migrated to
read `PORTAL_*` directly, the env-var map changes — but no code change
is required at the registrar or in Vercel.)

---

## Step 2 — DNS: add the CNAME record

**⚠ Operator action required.** Only the domain registrar owner can
apply this.

1. Log into the registrar for `kairikos.com`.
2. Navigate to DNS / Zone records for `kairikos.com`.
3. Add a new **CNAME** record:
   - **Name / Host / Prefix:** `portal`
   - **Target / Value / Points to:** the exact Vercel target from
     Step 1 (typically `cname.vercel-dns.com`, but verify)
   - **TTL:** `Auto` or `300`
4. Save the record.
5. Verify from any machine with `dig`:

   ```bash
   dig @1.1.1.1 portal.kairikos.com CNAME +short
   ```

   Expect: the Vercel target you pasted.

---

## Step 3 — Vercel: wait for TLS

1. Back in Vercel → **Settings → Domains**, the new row will show
   "Invalid Configuration" until DNS propagates.
2. Vercel auto-provisions the Let's Encrypt cert once DNS resolves
   (typically 5–30 minutes).
3. Verify cert:

   ```bash
   curl -sI https://portal.kairikos.com/ | head -1
   ```

   Expect: `HTTP/2 200` (or a Vercel holding page if the frontend
   isn't deployed yet) with a valid `*.vercel-dns.com` issuer.

---

## Step 4 — Supabase: confirm email sender + redirect config

**⚠ Operator action required.** The Supabase project owner login is
needed to confirm the sender domain is warmed up.

1. Open the Kairikos Supabase project.
2. **Authentication → URL Configuration:**
   - **Site URL:** `https://portal.kairikos.com`
   - **Additional Redirect URLs:** add
     `https://portal.kairikos.com/api/auth/callback`
3. **Authentication → Email Templates → Sender:**
   - Confirm the sending address is `noreply@kairikos.com` (or
     another warmed-up Kairikos domain — the same one used by the
     T+N email sequence is the safe default).
   - If not set, update to `noreply@kairikos.com` and verify DKIM/SPF
     for `kairikos.com` is published. (DKIM/SPF is out of scope for
     this runbook — it should already be configured per the email
     sequence work.)
4. **Test send:** trigger a magic-link from the dev portal against a
   real Gmail address. Confirm it arrives in the **primary inbox**
   within 30 seconds and is signed by `kairikos.com`.

---

## Step 5 — Verify the full flow (golden path)

1. `dig portal.kairikos.com CNAME +short` → Vercel target.
2. `curl -sI https://portal.kairikos.com/` → `HTTP/2 200` with valid
   cert.
3. Visit `https://portal.kairikos.com/portal/login` in a browser.
4. Submit a known client email (e.g. `onboarding-test1@kairikos.dev`
   from the staging seed).
5. Confirm the magic-link email arrives in the **primary inbox** of a
   real Gmail account within 30 seconds.
6. Click the link — should land on `/portal` (or `/portal/onboarding`
   for a mid-onboarding client).
7. Page `<head>` shows:
   - `<title>` and `<meta name="description">` in Spanish
   - `<meta property="og:title">`, `og:description` matching
   - `<link rel="canonical" href="https://portal.kairikos.com/...">`

---

## Rotation

### Change the CNAME target later

1. Vercel → Settings → Domains → note the new target.
2. Registrar → update the `portal` CNAME record.
3. Wait for TTL to expire (≤ 5 min if TTL=300).
4. `dig portal.kairikos.com CNAME +short` → new target.
5. Vercel auto-renews the TLS cert for the new target.

### Change the Supabase email sender

1. Update the sender address in Supabase Authentication settings.
2. Re-verify DKIM/SPF for the new domain.
3. Re-run Step 5.

---

## Rollback

**DNS rollback:** set the `portal` CNAME back to the previous target
(or delete the record). Vercel stops serving the domain within
minutes. DNS propagation is the only lag.

**Vercel domain rollback:** Settings → Domains → `portal.kairikos.com`
→ **Remove**. The DNS record is unaffected; remove that separately if
you want a clean slate.

**Supabase rollback:** revert the Site URL and the sender address to
the previous values. No data loss — these are config-only.

---

## What an agent can do without the operator

- Save this runbook (done in this commit).
- Keep the runbook in sync with code changes to the env-var map.
- Verify the magic-link flow **after** the operator confirms Steps 2
  and 4 are applied.
- File a follow-up issue if the operator's confirmation is delayed
  past the agreed SLA.

## What only the operator can do

- Apply the CNAME record change at the registrar.
- Confirm the Supabase sender domain is warmed up.
- Re-verify DKIM/SPF if the sender domain is changed.
