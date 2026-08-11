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

// =============================================================================
// KAIA-14409 follow-up — topology-based pooler detection.
//
// The first KAIA-14409 cut detected the pooler via the `pgbouncer` query
// flag. That flag is not evidence of a pooler: `@/lib/prisma` appends
// `?pgbouncer=true&connection_limit=1` to whatever `DATABASE_URL` holds
// (KAIA-2872) — including a direct `localhost:5432` dev URL — and
// `onboarding-actions.ts` imports `@/lib/prisma` BEFORE `@/lib/prisma-direct`,
// so the mutation lands first. Result: a false NEGATIVE in dev/CI that
// silently routed the onboarding flow back through the pooler client.
// =============================================================================

describe('KAIA-14409 follow-up — isPooledDirectUrl detects topology, not flags', () => {
  it('flags port 6543 (transaction mode) wherever it appears', async () => {
    const { isPooledDirectUrl } = await import('@/lib/prisma-direct');
    expect(
      isPooledDirectUrl(
        'postgres://postgres:pw@aws-0-eu-west-3.pooler.supabase.com:6543/postgres?pgbouncer=true',
      ),
    ).toBe(true);
    expect(isPooledDirectUrl(undefined)).toBe(true);
  });

  it('ACCEPTS the session-mode pooler on :5432 (KAIA-14409 v3)', async () => {
    // The v2 guard rejected any *.pooler.supabase.com host, which ruled out
    // the ONLY topology that actually works on Vercel. The true direct host
    // (db.<ref>.supabase.co:5432) is IPv6-only and Vercel Lambda has no IPv6
    // egress, so it can never connect. Session mode on :5432 pins one
    // backend per connection — the guarantee read-after-write needs — and
    // is IPv4-reachable.
    const { isPooledDirectUrl } = await import('@/lib/prisma-direct');
    expect(
      isPooledDirectUrl(
        'postgres://postgres:pw@aws-0-eu-west-3.pooler.supabase.com:5432/postgres',
      ),
    ).toBe(false);
  });

  it('does NOT flag a direct URL merely because it carries pgbouncer flags', async () => {
    const { isPooledDirectUrl } = await import('@/lib/prisma-direct');
    expect(
      isPooledDirectUrl(
        'postgresql://kairikos:dev@localhost:5432/kairikos_portal?schema=public&pgbouncer=true&connection_limit=1',
      ),
    ).toBe(false);
    expect(
      isPooledDirectUrl(
        'postgres://postgres:pw@db.example-ref.supabase.co:5432/postgres',
      ),
    ).toBe(false);
  });

  it('stays direct in dev after @/lib/prisma mutates DATABASE_URL (real import order)', async () => {
    // Reproduces the app's own import order in
    // src/app/admin/portal/[clientId]/onboarding-actions.ts.
    process.env.DATABASE_URL =
      'postgresql://kairikos:dev@localhost:5432/kairikos_portal?schema=public';

    await import('@/lib/prisma');
    // @/lib/prisma has now rewritten DATABASE_URL in place.
    expect(process.env.DATABASE_URL).toContain('pgbouncer=true');

    const mod = await import('@/lib/prisma-direct');
    expect(mod.isDatabaseDirectConfigured).toBe(true);
    expect(mod.directUrlSource).toBe('DATABASE_URL');
  });

  it('reports directUrlSource for each resolution tier', async () => {
    process.env.DIRECT_URL =
      'postgres://postgres:pw@db.prod.supabase.co:5432/postgres';
    const a = await import('@/lib/prisma-direct');
    expect(a.directUrlSource).toBe('DIRECT_URL');

    vi.resetModules();
    clearDirectEnv();
    process.env.SUPABASE_DB_URL =
      'postgres://postgres:pw@db.staging.supabase.co:5432/postgres';
    const b = await import('@/lib/prisma-direct');
    expect(b.directUrlSource).toBe('SUPABASE_DB_URL');
  });

  it('reports directUrlSource "none" when only a pooled URL is present', async () => {
    process.env.DATABASE_URL =
      'postgres://postgres:pw@aws-0-eu-west-3.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mod = await import('@/lib/prisma-direct');
    expect(mod.isDatabaseDirectConfigured).toBe(false);
    expect(mod.directUrlSource).toBe('none');
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('KAIA-14409'));
  });
});

// =============================================================================
// KAIA-14409 v3 — the production topology that actually works.
//
// Proven from this container (see issue comment for full output):
//
//   dns.resolve4('db.<ref>.supabase.co')          -> ENODATA
//   dns.resolve6('db.<ref>.supabase.co')          -> 2a05:d012:...
//   net.connect(db.<ref>...:5432,  family: 4)     -> ENOTFOUND
//   net.connect(pooler...:5432,    family: 4)     -> CONNECTED
//   net.connect(pooler...:6543,    family: 4)     -> CONNECTED
//
// Vercel Lambda has no IPv6 egress, so DIRECT_URL must point at the
// session-mode pooler (:5432), never at db.<ref>.supabase.co.
// =============================================================================

describe('KAIA-14409 v3 — session-mode pooler is a valid direct URL', () => {
  it('treats the session-mode pooler URL as direct and configured', async () => {
    process.env.DIRECT_URL =
      'postgres://postgres.ref:pw@aws-0-eu-west-3.pooler.supabase.com:5432/postgres';
    const mod = await import('@/lib/prisma-direct');
    expect(mod.isDatabaseDirectConfigured).toBe(true);
    expect(mod.directUrlSource).toBe('DIRECT_URL');
  });

  it('still rejects the transaction-mode pooler URL', async () => {
    process.env.DIRECT_URL =
      'postgres://postgres.ref:pw@aws-0-eu-west-3.pooler.supabase.com:6543/postgres?pgbouncer=true';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const mod = await import('@/lib/prisma-direct');
    expect(mod.isDatabaseDirectConfigured).toBe(false);
    expect(mod.directUrlSource).toBe('none');
  });

  it('accepts the IPv6-only direct host as a URL (transport failure is caught at query time)', async () => {
    // The guard is about pooling semantics, not reachability — we cannot
    // resolve DNS at module load. Reachability is handled by the runtime
    // fallback in [clientId]/page.tsx, which catches the ENOTFOUND and
    // re-reads through the pooled client instead of rendering empty.
    process.env.DIRECT_URL =
      'postgres://postgres:pw@db.example-ref.supabase.co:5432/postgres';
    const mod = await import('@/lib/prisma-direct');
    expect(mod.isDatabaseDirectConfigured).toBe(true);
  });
});
