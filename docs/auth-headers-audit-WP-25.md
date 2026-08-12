# Auth-header audit (WP-25)

Follow-up to the WP-00 hotfix: `authenticateRequest()` trusted the
client-controlled `x-kairikos-operator` header to grant operator
privileges. That was one instance of a pattern, not the whole pattern —
this is the inventory WP-00 promised, covering every header any route
under `src/app/api/**` or helper under `src/lib/` reads and uses to
decide identity, role, or permission.

**Date:** 2026-08-12
**Scope:** every `req.headers.get(...)` / `headers().get(...)` call site
under `portal/src/app/api/**` and `portal/src/lib/**`, cross-referenced
against `portal/src/app/api/internal/**`'s route list.

## Method

`grep -rn "headers.get\|headers().get"` across `src/app/api` and
`src/lib`, then triaged every match into "used for an auth decision" vs.
"informational" (routing, logging, URL construction). For each
auth-relevant header, checked: (a) is the expected value something the
caller cannot set themselves, and (b) is the comparison constant-time.

## Headers used for identity/role/permission decisions

| Header | Where | Backed by | Comparison | Status |
| --- | --- | --- | --- | --- |
| `x-kairikos-operator` | `api-auth.ts` (`authenticateRequest`) | ~~client-supplied boolean~~ | — | **Fixed in WP-00.** No longer read for `isOperator`. |
| `x-kaia-operator-key` | `operator-session.ts` (`authenticateAdminRequest`), `session.ts` (`resolveOperatorKeyBypass`), `admin/portal/clients/[id]/route.ts` (local `operatorKeyAuth`) | `KAIA_OPERATOR_API_KEY` env var | Constant-time (`constantTimeEqual`, fixed in WP-00 for the first; the other two already were) | OK — three call sites, same secret, same comparison after this WP's consolidation (see below). |
| `x-internal-activity-key` | `activity-key-auth.ts` | `KAIRIKOS_INTERNAL_ACTIVITY_KEY` env var (deliberately distinct from `PORTAL_API_KEY` — see the file's own blast-radius comment) | Constant-time | OK |
| `x-portal-api-key` / `x-kairikos-internal-key` | `internal-auth.ts` | `PORTAL_API_KEY` env var | Constant-time | OK |
| `x-qa-probe-token` | `api/qa-probe/route.ts` | `QA_PROBE_TOKEN` env var (also gated: route 404s if unset or < 32 chars) | Was a hand-rolled XOR loop that returned `false` immediately on length mismatch (leaks secret length via timing) — **fixed this WP**, now uses the shared `constantTimeEqual`. | Fixed |
| `x-qa-seed-token` | `api/qa/seed-test-passwords/route.ts` | `QA_SEED_TOKEN` env var | Same length-leak pattern — **fixed this WP**. | Comparison fixed. **Still flagged**: no environment gate at all (see below). |
| `authorization: Bearer …` | `api-auth.ts` | validated against the legacy `PORTAL_API_BASE_URL` backend (real sessions) or the dev-mock fixture set (no backend configured) | N/A (opaque token, not a shared secret comparison) | Unrelated to the header-trust class of bug; the token itself is what's being authenticated, not compared against a static value. |
| `stripe-signature` | `api/stripe/webhook/route.ts` | Stripe's own HMAC signing key, verified via the Stripe SDK | Stripe SDK-internal | Not client-controlled in the vulnerable sense — Stripe signs it. |

## Constant-time comparison: consolidated

Found **six** near-identical constant-time string-comparison
implementations across `operator-crypto.ts`, `internal-auth.ts`,
`activity-key-auth.ts`, `session.ts`, `qa-probe/route.ts`, and
`qa/seed-test-passwords/route.ts`. Three different quality levels:

- Two (`internal-auth.ts`, `activity-key-auth.ts`) already padded the
  shorter buffer and ran `timingSafeEqual` even on a length mismatch —
  correct, length-blind.
- The shared `operator-crypto.ts` export and the two ad-hoc ones in
  `session.ts` / `qa-probe/route.ts` / `qa/seed-test-passwords/route.ts`
  all returned `false` immediately on a length mismatch — the check
  itself leaks the expected secret's length through response timing.

Fixed `operator-crypto.ts`'s `constantTimeEqual` to the length-blind
version and pointed all six call sites at it, deleting the five local
duplicates. One implementation, used everywhere a shared secret is
compared against a header value.

## `api/internal/**` inventory (AC: "documented with what secret protects it and what a leak enables")

All 13 routes fail closed (500) if their env var is unset, and none
read any client-controlled header for the trust decision itself.

| Route | Secret | If leaked |
| --- | --- | --- |
| `activity/route.ts` | `PORTAL_API_KEY` | Write `ChatbotActivity` milestones for any client — the n8n workflow write surface. |
| `clients/[id]/state-transition/route.ts` | `KAIRIKOS_INTERNAL_ACTIVITY_KEY` (deliberately separate — see file header) | Flip `ChatbotClient.state` for any client (go-live-pending / live / paused / archived / in-progress / draft). Does **not** grant the `PORTAL_API_KEY` surface or vice versa. |
| `health-probe/ping/route.ts`, `health-probe/run/route.ts` | `PORTAL_API_KEY` | Trigger the health-probe workflow. Read-only-ish; low blast radius on its own, but same key as the write routes below. |
| `lookup-client/route.ts`, `lookup-client-id-from-supabase/route.ts` | `PORTAL_API_KEY` | Look up client records by email/id — a data-exposure surface, not a write surface. |
| `n8n-execution/route.ts` | `PORTAL_API_KEY` | Write `N8nExecution` rows — the flow-health dashboard's data source. |
| `notify-operator/route.ts` | `PORTAL_API_KEY` | Trigger an operator notification email for any client. |
| `review-overdue/fire/route.ts`, `review-overdue/scan/route.ts` | `PORTAL_API_KEY` | Fire/scan the reviews-overdue automation. |
| `rotate-secret/route.ts` | `PORTAL_API_KEY` | **Highest-value target of the twelve** — rotates a secret. Same key as everything else in this list, so a `PORTAL_API_KEY` leak already implies this regardless. |
| `wizard-abandoned/fire/route.ts`, `wizard-abandoned/scan/route.ts` | `PORTAL_API_KEY` | Fire/scan the wizard-abandoned automation. |

Twelve of thirteen routes share one secret (`PORTAL_API_KEY`). That's a
single blast radius, not per-route isolation — a leak of that one key
is equivalent to leaking all twelve. Worth a product/ops call on
whether that's acceptable (n8n needs one credential to drive all of
these today) or whether `rotate-secret` in particular — the one route
in this list that can itself mint new secrets — should move to its own
key the way `state-transition` already did for exactly this reason. Not
changed in this WP; flagging the asymmetry rather than picking a
scope split unilaterally.

## Dead code removed

`portal-session.ts` exported `readDevEmailHeader()`, reading
`x-kairikos-dev-email` with no validation and no caller anywhere in the
codebase — the `'header_dev'` value in `ResolvedClient['source']` was
never actually produced by any code path either. Both removed. Even
dead, this was exactly the kind of latent surface a future change could
wire up without noticing it skips the `isPortalDevMock()` gate the
neighboring dev-mock code paths all have.

## Flagged, not fixed

`api/qa/seed-test-passwords/route.ts` spawns a local script
(`scripts/seed-test-passwords.ts`) gated only by the `x-qa-seed-token`
header against `QA_SEED_TOKEN` — no environment check at all. Every
other `api/qa-*` / `api/internal/*` route in this repo either 404s when
its token env var is absent (`qa-probe`) or is scoped to the internal
service boundary; this one has neither a length/format floor on the
token (`qa-probe` requires ≥ 32 chars) nor an environment gate. A
`NODE_ENV === 'production'` check the way WP-00 added for the
`operator-dev` backdoor would be the obvious fix, **except**: nothing in
this repo (docs, scripts, CI config) references this route, so it's
unclear whether an external QA harness depends on it reaching the
staging Vercel deploy — and that deploy is itself Vercel-Production-
typed (see `STAGING.md`), so `NODE_ENV`/`VERCEL_ENV` can't distinguish
"real prod" from "staging" here the way it could for the dev-only
`operator-dev` case. Needs a decision from whoever knows if anything
external still calls this before restricting it.

## Related

- [WP-00 hotfix](../portal/src/lib/api-auth.ts) — the original finding.
- Plan artifact, Fase 0 / WP-25 entry (this WP's origin).
