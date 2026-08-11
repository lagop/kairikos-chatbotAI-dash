// =============================================================================
// Kairikos portal — direct-connection Prisma client singleton (KAIA-14388).
//
// QA smoke (2026-08-11) showed the operator-side `Iniciar onboarding` server
// action upserts a `chatbotActivity` row (verified live via
// `/api/admin/portal/flows: currentMilestone=T+0`, `lastActivityAt` matches the
// click) but the admin overview page read never sees the write. The row stays
// invisible after a fresh `page.goto`, so it is not a React cache problem — it
// is a Prisma × Supabase transaction-mode PgBouncer staleness problem.
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
// Fix path chosen (KAIA-14388, Backend Developer, A from the issue's
// suggested-fix list):
//
//   Use a DIRECT (port 5432) Prisma client for the operator-side onboarding
//   advance flow only. The action's write AND the page's matching read both
//   bypass the pooler so they share the same physical connection. This
//   mirrors the topology `prisma migrate deploy` already uses
//   (`SUPABASE_DB_URL` at port 5432).
//
//   Scope is deliberately narrow: ONLY the `chatbotActivity` write/read in
//   the operator-side onboarding flow. Everything else in the portal keeps
//   using the pooler-friendly `prisma` client from `@/lib/prisma`.
//
// Resolution order (same as `@/lib/prisma`):
//
//   1. `SUPABASE_DB_URL` — staging/production direct URL (port 5432).
//   2. `DATABASE_URL`     — local Docker / dev fallback. Already
//                            `localhost:5432`, so the direct path is the
//                            default in dev too.
//
// `isDatabaseDirectConfigured` is exported so callers can decide whether the
// fix is in effect (mirrors `isDatabaseConfigured` from `@/lib/prisma`).
// =============================================================================

import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __kairikosPortalPrismaDirect: PrismaClient | undefined;
}

function resolveDirectUrl(): string | undefined {
  const direct = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;
  if (!direct) return undefined;
  return direct;
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

export const isDatabaseDirectConfigured = Boolean(_directUrl);
