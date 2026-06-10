# Kairikos Portal — frontend

Next.js 14 (App Router) frontend for the end-client portal at `portal.kairikos.com`.

## Stack

- Next.js 14 App Router
- React 18
- Tailwind CSS (Kairikos design tokens)
- Supabase Auth (magic link) via `@supabase/ssr`
- Light page-view analytics via `/api/portal/track`

## Local development

```bash
cd portal
npm install
cp .env.example .env.local
npm run dev
```

The dev server runs on `http://localhost:3001`.

If Supabase is not configured, the portal runs against an in-memory mock client
(`Peluquería Aurora`) so the UI is always demo-able. The mock data lives in
`src/lib/portal-data.ts` and is replaced by real data once the backend endpoints
in `KAIA-732` are live.

## Routes

- `/` → redirects to `/portal` (will be served at `/portal` on the live domain).
- `/portal/login` — email magic-link form.
- `/portal/sin-acceso` — friendly "no portal access" page for non-client emails.
- `/portal` — landing dashboard: onboarding summary + chatbot status.
- `/portal/onboarding` — full onboarding timeline.
- `/portal/chatbot` — chatbot live status + 7-day metrics.
- `/portal/conversations` — last 50 conversations.
- `/portal/conversations/[id]` — single transcript.
- `/portal/billing` — current tier, fee, next invoice, Stripe Customer Portal link.
- `/portal/support` — WhatsApp / email contact.
- `/api/portal/login` — server endpoint that sends the Supabase magic link.
- `/api/portal/track` — server endpoint for page_view analytics.
- `/api/auth/callback` — Supabase email-link callback (exchanges code for session).

## Environment variables

See `.env.example`.

| Var | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key (public) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role (server only) — only needed for admin tasks |
| `PORTAL_API_BASE_URL` | NestJS portal API base URL (`https://api.kairikos.com` in prod) |
| `PORTAL_ANALYTICS_ENDPOINT` | Optional analytics collector URL (no-op if blank) |
| `PORTAL_ANALYTICS_SITE_ID` | Analytics site id (default `kairikos-portal`) |
| `NEXT_PUBLIC_PORTAL_URL` | Canonical portal URL (used for OG metadata) |

## Integration contract (frontend ↔ backend)

The frontend calls these endpoints with the client's Supabase JWT in
`Authorization: Bearer …`. Backend (KAIA-732) must enforce RLS.

- `GET /portal/me` → `ClientProfile`
- `GET /portal/onboarding-status` → `{ timeline: OnboardingTimelineRow[] }`
- `GET /portal/chatbot-status` → `ChatbotStatusSummary`
- `GET /portal/conversations` → `{ conversations: ConversationSummary[] }`
- `GET /portal/conversations/:id` → `ConversationTranscript`
- `GET /portal/billing` → `BillingSummary`
- `GET /portal/support-link` → `SupportLink`

Types live in `src/types/portal.ts`.

## Accessibility

- Color contrast checked against the dark Kairikos tokens.
- Semantic landmarks (`<header>`, `<main>`, `<footer>`, `<nav>`, `<section>` with `aria-label`).
- Keyboard-navigable focus states on all interactive elements.
- `aria-label`s on all icon-only links and pill statuses.

## Deploy

The portal runs on the **Kairikos VPS** as part of the Docker Compose
stack in `../docker-compose.yml` (PostgreSQL 16 + Next.js 14 app +
nginx + certbot). Set-up, CI/CD, and TLS are owned by
[KAIA-754](/KAIA/issues/KAIA-754) (status: `done`). Domain
`portal.kairikos.com` resolves to the VPS front; the cert is managed
by certbot inside the compose stack.

> **Historical note:** an earlier rev 2 of this README pointed at a
> Vercel project per the (since-cancelled) [KAIA-735](/KAIA/issues/KAIA-735).
> The rev 3 architecture is Prisma + PostgreSQL on the VPS + NextAuth +
> Resend, owned by [KAIA-752](/KAIA/issues/KAIA-752),
> [KAIA-753](/KAIA/issues/KAIA-753), [KAIA-754](/KAIA/issues/KAIA-754),
> [KAIA-755](/KAIA/issues/KAIA-755). All four are `done`.

Env vars for the VPS deploy come from the deployment secret store, not
Vercel. See `../.env.example` and `portal/.env.example` for the full
list (DATABASE_URL, AUTH_SECRET, RESEND_API_KEY, NEXTAUTH_URL,
PORTAL_API_KEY, etc.).
