// =============================================================================
// Kairikos portal — direct-connection Prisma client singleton (KAIA-14388 /
// KAIA-14409).
//
// QA smoke (2026-08-11) on the KAIA-14345 operator-side `Iniciar onboarding`
// flow showed the upsert write is committed (verified via
// `/api/admin/portal/flows: currentMilestone=T+0`, `lastActivityAt` matches
// the click) but the matching page read never sees it. The row stays
// invisible after a fresh `page.goto`, so it is not a React cache problem —
// it is a Prisma × Supabase transaction-mode PgBouncer staleness problem.
//
// Root cause (see KAIA-2872 history for the prior 42P05 hardening):
//
//   - `src/lib/prisma.ts` constructs the client with
//     `?pgbouncer=true&connection_limit=1` so each statement-level commit
//     completes against whatever physical connection PgBouncer (port 6543,
//     transaction mode) hands out.
//   - The action (`src/app/admin/portal/[clientId]/onboarding-actions.ts`)
//     `prisma.chatbotActivity.upsert(...)` — write lands on PgBouncer pool
//     slot A.
//   - The page (`src/app/admin/portal/[clientId]/page.tsx`) calls
//     `prisma.chatbotActivity.findMany(...)` after `revalidatePath` — read
//     lands on PgBouncer pool slot B and cannot see A's just-committed write.
//
// Fix path (KAIA-14388 + KAIA-14409): route the operator-side onboarding
// advance flow through a DIRECT (port 5432, no pooler) Prisma client. The
// action's write AND the page's matching read both bypass the pooler so
// they share the same physical connection — mirroring the topology
// `prisma migrate deploy` already uses.
//
// Scope is deliberately narrow: ONLY the `chatbotActivity` write/read in
// the operator-side onboarding flow. Everything else in the portal keeps
// using the pooler-friendly `prisma` client from `@/lib/prisma`.
//
// Resolution order (KAIA-14409 update — `DIRECT_URL` is the conventional
// Prisma / Supabase name and is what the Vercel project ships configured;
// `SUPABASE_DB_URL` is preserved as a secondary alias for environments
// that prefer it; `DATABASE_URL` is the pooler URL and must NOT be picked
// up here because it is the source of the staleness bug):
//
//   1. `DIRECT_URL`        — Vercel project-fxidg production + preview
//                            (also used by Prisma's `directUrl` convention).
//   2. `SUPABASE_DB_URL`   — secondary alias (e.g. self-hosted supabase /
//                            older deploy scripts that exported this name).
//   3. `DATABASE_URL`      — local Docker / dev fallback. Already
//                            `localhost:5432` in dev, so it is direct in
//                            dev too.
//
// `isDatabaseDirectConfigured` is exported so callers can decide whether
// the fix is in effect (mirrors `isDatabaseConfigured` from `@/lib/prisma`).
// It deliberately **rejects** pooled URLs: if the resolution above fell
// through to `DATABASE_URL` and that URL still carries `:6543` or
// `pgbouncer=true`, the flag is `false`, so callers fall back to the
// pooler-bound `prisma` and don't pretend the fix is active. Without this
// guard the false-positive from KAIA-14409 recurs anywhere the pooled URL
// is the only one configured.
// =============================================================================

import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __kairikosPortalPrismaDirect: PrismaClient | undefined;
}

// KAIA-14409 follow-up — detect the pooler by TOPOLOGY (host / port), not by
// the `pgbouncer` query flag.
//
// The flag is not evidence of a pooler: `@/lib/prisma` rewrites
// `process.env.DATABASE_URL` in place to append
// `?pgbouncer=true&connection_limit=1` (KAIA-2872) to whatever it finds —
// including a perfectly direct `localhost:5432` dev URL. Because
// `onboarding-actions.ts` imports `@/lib/prisma` BEFORE `@/lib/prisma-direct`,
// that mutation has already happened by the time we resolve here. Keying off
// the flag therefore turned the dev fallback into a false NEGATIVE: local and
// CI runs reported `isDatabaseDirectConfigured === false` and quietly routed
// the onboarding flow back through the pooler client, so the read-after-write
// path the fix exists to exercise was never actually exercised outside prod.
//
// Port 6543 and the `*.pooler.supabase.com` hostname are topology facts and
// cannot be introduced by our own flag-appending, so we key off those instead.
export function isPooledDirectUrl(url: string | undefined): boolean {
  if (!url) return true;
  if (!/^postgres(?:ql)?:\/\//i.test(url)) return true;
  try {
    const parsed = new URL(url);
    if (parsed.port === '6543') return true;
    if (/(^|\.)pooler\.supabase\.com$/i.test(parsed.hostname)) return true;
    return false;
  } catch {
    // Unparseable — stay conservative so a malformed pooler URL still
    // cannot masquerade as direct.
    return /:6543(?:\/|\?|$)/.test(url) || /pooler\.supabase\.com/i.test(url);
  }
}

function resolveDirectUrl(): string | undefined {
  return (
    process.env.DIRECT_URL ??
    process.env.SUPABASE_DB_URL ??
    process.env.DATABASE_URL
  );
}

const _directUrl = resolveDirectUrl();

export const prismaDirect: PrismaClient =
  globalThis.__kairikosPortalPrismaDirect ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    datasources: _directUrl ? { db: { url: _directUrl } } : undefined,
  });

if (process.env.NODE_ENV !== 'production') {
  globalThis.__kairikosPortalPrismaDirect = prismaDirect;
}

// Genuine-direct only: a pooled URL is the source of the staleness bug and
// must NOT be advertised as a working direct connection (KAIA-14409).
export const isDatabaseDirectConfigured = Boolean(
  _directUrl && !isPooledDirectUrl(_directUrl),
);

/**
 * Which env var supplied the direct URL, or why none did. Safe to log — it
 * never contains the URL itself (which carries the DB password).
 */
export const directUrlSource: 'DIRECT_URL' | 'SUPABASE_DB_URL' | 'DATABASE_URL' | 'none' =
  !isDatabaseDirectConfigured
    ? 'none'
    : process.env.DIRECT_URL
      ? 'DIRECT_URL'
      : process.env.SUPABASE_DB_URL
        ? 'SUPABASE_DB_URL'
        : 'DATABASE_URL';

if (!isDatabaseDirectConfigured && _directUrl) {
  // KAIA-14409 was invisible precisely because the misconfiguration was
  // silent — the fix looked deployed while being inert. Say so once at
  // module load so the condition is greppable in Vercel logs instead of
  // only observable as a stale timeline in the UI.
  console.error(
    '[prisma-direct] KAIA-14409: resolved Postgres URL is pooler-bound ' +
      '(port 6543 / *.pooler.supabase.com). Operator onboarding ' +
      'read-after-write WILL be stale. Set DIRECT_URL to the port-5432 ' +
      'direct connection string.',
  );
}
