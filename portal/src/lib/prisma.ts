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
// =============================================================================

import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __kairikosPortalPrisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  globalThis.__kairikosPortalPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalThis.__kairikosPortalPrisma = prisma;
}

export const isDatabaseConfigured = Boolean(process.env.DATABASE_URL);
