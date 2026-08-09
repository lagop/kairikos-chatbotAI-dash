// =============================================================================
// Kairikos portal — Prisma client singleton (KAIA-755)
//
// The Next.js dev server hot-reloads modules, which can leak PrismaClient
// instances and exhaust the database connection pool. Stash the client on
// `globalThis` in dev so the same instance is reused across reloads.
//
// `isDatabaseConfigured` is true when DATABASE_URL is set. When false, callers
// should fall back to the mock data in `portal-data.ts` so the UI is always
// demoable.
//
// KAIA-2872 — Supabase transaction-mode pooler (port 6543) is incompatible
// with Prisma's default extended-query prepared-statement cache. We append
// `?pgbouncer=true&connection_limit=1` in code (via the `prisma-pg-flags`
// helper) so the fix is durable regardless of what the Vercel env
// currently contains, AND we also pass the resolved URL to the
// PrismaClient constructor via `datasources.db.url` so the override is
// guaranteed to take effect at the Prisma query-engine layer.
// =============================================================================

import { PrismaClient } from '@prisma/client';
import { ensurePgBouncerFlags } from './prisma-pg-flags';

declare global {
  // eslint-disable-next-line no-var
  var __kairikosPortalPrisma: PrismaClient | undefined;
}

const _rawUrl = process.env.DATABASE_URL;
const _resolvedUrl = ensurePgBouncerFlags(_rawUrl);

if (_rawUrl && _resolvedUrl && _resolvedUrl !== _rawUrl) {
  // Mirror the mutation into process.env so any non-Prisma code path
  // (e.g. `prisma migrate` via npx) also sees the corrected URL.
  process.env.DATABASE_URL = _resolvedUrl;
}

export const prisma: PrismaClient =
  globalThis.__kairikosPortalPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    datasources: _resolvedUrl ? { db: { url: _resolvedUrl } } : undefined,
  });

if (process.env.NODE_ENV !== 'production') {
  globalThis.__kairikosPortalPrisma = prisma;
}

export const isDatabaseConfigured = Boolean(process.env.DATABASE_URL);
