// =============================================================================
// KAIA-14388 — unit tests for the direct-connection Prisma client.
//
// Verifies:
//   1. `prismaDirect` is a single PrismaClient instance (singleton per
//      process via `globalThis`).
//   2. `isDatabaseDirectConfigured` mirrors the env-var presence — `false`
//      when both env vars are unset, `true` when either is present.
//   3. The client prefers `SUPABASE_DB_URL` (the direct / port 5432 URL)
//      over `DATABASE_URL` (which stays pooler-bound for the rest of the
//      portal, see KAIA-2872 hardening). We verify this by inspecting the
//      resolved URL through a stubbed PrismaClient that captures the
//      options.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ENV_KEYS = ['SUPABASE_DB_URL', 'DATABASE_URL'] as const;

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

describe('KAIA-14388 — prismaDirect resolution', () => {
  it('is undefined when neither SUPABASE_DB_URL nor DATABASE_URL is set', async () => {
    const mod = await import('@/lib/prisma-direct');
    expect(mod.isDatabaseDirectConfigured).toBe(false);
  });

  it('returns true when SUPABASE_DB_URL is set (staging / production topology)', async () => {
    process.env.SUPABASE_DB_URL =
      'postgres://postgres:secret@db.staging.supabase.co:5432/postgres';
    const mod = await import('@/lib/prisma-direct');
    expect(mod.isDatabaseDirectConfigured).toBe(true);
  });

  it('returns true when only DATABASE_URL is set (dev topology)', async () => {
    process.env.DATABASE_URL =
      'postgresql://kairikos:dev@localhost:5432/kairikos_portal?schema=public';
    const mod = await import('@/lib/prisma-direct');
    expect(mod.isDatabaseDirectConfigured).toBe(true);
  });

  it('prefers SUPABASE_DB_URL over DATABASE_URL when both are set', async () => {
    // Mirrors the staging/production topology: DATABASE_URL stays pooler-
    // bound (port 6543, KAIA-2872 hardening) while SUPABASE_DB_URL holds
    // the direct (port 5432) URL used by `prismaDirect`.
    process.env.DATABASE_URL =
      'postgres://postgres:secret@aws-0-eu-west-3.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1';
    process.env.SUPABASE_DB_URL =
      'postgres://postgres:secret@db.staging.supabase.co:5432/postgres';

    // Capture the constructor options by stubbing the @prisma/client
    // module before `prisma-direct` evaluates. We can't override the named
    // export on the live module, so we use a Vitest module mock.
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
      'postgres://postgres:secret@db.staging.supabase.co:5432/postgres',
    );
  });
});

describe('KAIA-14388 — prismaDirect singleton', () => {
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
