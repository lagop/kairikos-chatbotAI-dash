// =============================================================================
// KAIA-14388 / KAIA-14409 — unit tests for the direct-connection Prisma client.
//
// Verifies:
//   1. `prismaDirect` is a single PrismaClient instance (singleton per
//      process via `globalThis`).
//   2. `isDatabaseDirectConfigured` mirrors a GENUINE direct (non-pooled)
//      URL being present — `false` when both env vars are unset OR when
//      the resolved URL is pooled (`:6543` / `pgbouncer=true`). Without
//      the pooled guard, KAIA-14409's false-positive recurs.
//   3. The client resolves URLs in this order (KAIA-14409 update):
//        a. `DIRECT_URL`        — Vercel production + preview.
//        b. `SUPABASE_DB_URL`   — secondary alias.
//        c. `DATABASE_URL`      — dev / pooler fallback.
//      We verify the preference chain by stubbing PrismaClient and
//      capturing the datasources URL passed to the constructor.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ENV_KEYS = ['DIRECT_URL', 'SUPABASE_DB_URL', 'DATABASE_URL'] as const;

function clearDirectEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

beforeEach(() => {
  vi.resetModules();
  clearDirectEnv();
});

afterEach(() => {
  clearDirectEnv();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('KAIA-14388 / KAIA-14409 — prismaDirect resolution', () => {
  it('treats only-pooled env as not-direct even if every lookup key resolves', async () => {
    // Hermetic: every lookup key resolves to a pooled URL and the resolver
    // therefore picks one of them as the "direct URL", but the embedded
    // `isPooledDirectUrl` guard must still report the flag as `false`.
    process.env.DIRECT_URL =
      'postgres://postgres:secret@aws-0-eu-west-3.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1';
    process.env.SUPABASE_DB_URL =
      'postgres://postgres:secret@aws-0-eu-west-3.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1';
    process.env.DATABASE_URL =
      'postgres://postgres:secret@aws-0-eu-west-3.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1';

    const ctorSpy = vi.fn();
    vi.doMock('@prisma/client', () => {
      class FakePrismaClient {
        constructor(opts: unknown) {
          ctorSpy(opts);
        }
        chatbotActivity = {};
      }
      return { PrismaClient: FakePrismaClient };
    });

    const mod = await import('@/lib/prisma-direct');
    expect(mod.isDatabaseDirectConfigured).toBe(false);
    // The PrismaClient is still constructed because a URL was found — the
    // resolution layer does not refuse to build the client, it just
    // advertises the wrong-ness up the call chain.
    expect(ctorSpy).toHaveBeenCalledTimes(1);
  });

  it('returns true when DIRECT_URL is set to a direct (port 5432) URL (production topology)', async () => {
    process.env.DIRECT_URL =
      'postgres://postgres:secret@db.staging.supabase.co:5432/postgres';
    const mod = await import('@/lib/prisma-direct');
    expect(mod.isDatabaseDirectConfigured).toBe(true);
  });

  it('returns true when only SUPABASE_DB_URL is set (legacy alias topology)', async () => {
    process.env.SUPABASE_DB_URL =
      'postgres://postgres:secret@db.staging.supabase.co:5432/postgres';
    const mod = await import('@/lib/prisma-direct');
    expect(mod.isDatabaseDirectConfigured).toBe(true);
  });

  it('returns true when only DATABASE_URL is set to a non-pooled URL (dev topology)', async () => {
    process.env.DATABASE_URL =
      'postgresql://kairikos:dev@localhost:5432/kairikos_portal?schema=public';
    const mod = await import('@/lib/prisma-direct');
    expect(mod.isDatabaseDirectConfigured).toBe(true);
  });

  it('returns FALSE when DATABASE_URL is the only env var and it points at PgBouncer (KAIA-14409 regression guard)', async () => {
    // This is the production failure pattern the FIRST deploy exhibited:
    // SUPABASE_DB_URL is unset, DIRECT_URL is unset, so resolution falls
    // through to DATABASE_URL which is the PgBouncer pooler URL. The
    // client is built but `isDatabaseDirectConfigured` must be `false`
    // so callers fall back to the pooler-bound `prisma` rather than
    // falsely selecting a Prisma client bound to the pooler.
    process.env.DATABASE_URL =
      'postgres://postgres:secret@aws-0-eu-west-3.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1';
    const mod = await import('@/lib/prisma-direct');
    expect(mod.isDatabaseDirectConfigured).toBe(false);
  });

  it('prefers DIRECT_URL over SUPABASE_DB_URL and DATABASE_URL when all three are set', async () => {
    // Production topology (KAIA-14409): DIRECT_URL holds the port-5432
    // direct URL; SUPABASE_DB_URL holds a different direct URL (legacy);
    // DATABASE_URL holds the PgBouncer :6543 pooled URL. We must land on
    // DIRECT_URL.
    process.env.DATABASE_URL =
      'postgres://postgres:secret@aws-0-eu-west-3.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1';
    process.env.SUPABASE_DB_URL =
      'postgres://postgres:secret@db.staging.supabase.co:5432/postgres';
    process.env.DIRECT_URL =
      'postgres://postgres:secret@db.production.supabase.co:5432/postgres';

    const ctorSpy = vi.fn();
    vi.doMock('@prisma/client', () => {
      class FakePrismaClient {
        constructor(opts: unknown) {
          ctorSpy(opts);
        }
        chatbotActivity = {};
      }
      return { PrismaClient: FakePrismaClient };
    });

    const mod = await import('@/lib/prisma-direct');
    expect(mod.isDatabaseDirectConfigured).toBe(true);
    expect(ctorSpy).toHaveBeenCalledTimes(1);
    const opts = ctorSpy.mock.calls[0][0] as {
      datasources?: { db?: { url?: string } };
    };
    expect(opts.datasources?.db?.url).toBe(
      'postgres://postgres:secret@db.production.supabase.co:5432/postgres',
    );
  });

  it('prefers SUPABASE_DB_URL over DATABASE_URL when DIRECT_URL is unset', async () => {
    process.env.DATABASE_URL =
      'postgres://postgres:secret@aws-0-eu-west-3.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1';
    process.env.SUPABASE_DB_URL =
      'postgres://postgres:secret@db.staging.supabase.co:5432/postgres';

    const ctorSpy = vi.fn();
    vi.doMock('@prisma/client', () => {
      class FakePrismaClient {
        constructor(opts: unknown) {
          ctorSpy(opts);
        }
        chatbotActivity = {};
      }
      return { PrismaClient: FakePrismaClient };
    });

    const mod = await import('@/lib/prisma-direct');
    expect(mod.isDatabaseDirectConfigured).toBe(true);
    const opts = ctorSpy.mock.calls[0][0] as {
      datasources?: { db?: { url?: string } };
    };
    expect(opts.datasources?.db?.url).toBe(
      'postgres://postgres:secret@db.staging.supabase.co:5432/postgres',
    );
  });
});

describe('KAIA-14388 / KAIA-14409 — prismaDirect singleton', () => {
  it('exports a PrismaClient instance', async () => {
    process.env.DATABASE_URL =
      'postgresql://kairikos:dev@localhost:5432/kairikos_portal?schema=public';
    const mod = await import('@/lib/prisma-direct');
    expect(mod.prismaDirect).toBeDefined();
    expect(typeof mod.prismaDirect.chatbotActivity).toBe('object');
  });

  it('is the same instance across two imports in dev (globalThis cache)', async () => {
    process.env.DATABASE_URL =
      'postgresql://kairikos:dev@localhost:5432/kairikos_portal?schema=public';
    process.env.NODE_ENV = 'development';
    const a = await import('@/lib/prisma-direct');
    const b = await import('@/lib/prisma-direct');
    expect(a.prismaDirect).toBe(b.prismaDirect);
  });
});
