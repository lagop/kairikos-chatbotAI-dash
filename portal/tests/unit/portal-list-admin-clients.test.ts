// =============================================================================
// KAIA-13702 — listAdminClients() must query Prisma directly when the DB is
// configured. The previous (KAIA-13680) implementation went through the
// local `/api/admin/portal/clients` route, gated on `isBackendConfigured =
// Boolean(PORTAL_API_BASE_URL)`. That gate is false on Vercel production
// (PORTAL_API_BASE_URL is not in the Vercel env var list), so the page
// rendered the three dev-mock fixtures instead of the real seeded rows
// (e.g. `clinica-dental-orly`). After this follow-up:
//
//   * When `DATABASE_URL` is set (`isDatabaseConfigured`), `listAdminClients()`
//     queries `prisma.chatbotClient.findMany` directly and maps the DB rows
//     to the `ChatbotClient` shape (DB columns: email / state / goLiveAt;
//     type expects primaryContactEmail / onboardingStatus / goLiveDate).
//   * When `DATABASE_URL` is unset (`!isDatabaseConfigured`, local `next dev`
//     without a backend), `listAdminClients()` returns the three dev-mock
//     fixtures directly so unit / smoke tests keep rendering the local
//     fixtures.
//   * Return type stays `Promise<ChatbotClient[]>` — the page shape is
//     unchanged. Empty DB rows return `[]` (page renders EmptyState).
//   * try/catch around findMany — never throw from a page data fetcher;
//     surface `[]` so the page renders the existing "Sin clientes" empty
//     state instead of crashing the operator session.
//
// Reference: working sibling at `portal/src/app/admin/portal/page.tsx:62`
// and abandoned commit `203b97e` on
// `remotes/origin/fix/kaia-13114-list-admin-clients-live-db`.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const findMany = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    chatbotClient: {
      findMany: (...args: unknown[]) => findMany(...args),
    },
  },
  isDatabaseConfigured: true,
}));

import { listAdminClients, MOCK_STARTER_CLIENT } from '@/lib/portal-data';

const STAGING_CLINICA_DENTAL_ORLY = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'clinica-dental-orly@example.com',
  name: 'Clinica Dental Orly',
  companyName: 'Clinica Dental Orly',
  tier: 'pro',
  stripeCustomerId: 'cus_orly_staging',
  state: 'live',
  goLiveAt: new Date('2026-08-05T09:00:00.000Z'),
  createdAt: new Date('2026-08-01T09:00:00.000Z'),
};

const STAGING_BRISA_BEACH = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'ops@brisabeach.example.com',
  name: 'Brisa Beach Houses',
  companyName: 'Brisa Beach Houses',
  tier: 'premium',
  stripeCustomerId: 'cus_brisa_staging',
  state: 'in-progress',
  goLiveAt: null,
  createdAt: new Date('2026-07-20T09:00:00.000Z'),
};

describe('listAdminClients (KAIA-13702, prisma read when DB configured)', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    // Silence the [listAdminClients] DEBUG diagnostic per QA request —
    // spy and discard instead of removing the log line from production.
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    findMany.mockReset();
    findMany.mockResolvedValue([STAGING_CLINICA_DENTAL_ORLY]);
  });

  afterEach(() => {
    findMany.mockReset();
    consoleSpy?.mockRestore();
  });

  it('returns the live Prisma rows when the DB is configured (clinica dental orly)', async () => {
    const result = await listAdminClients();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(STAGING_CLINICA_DENTAL_ORLY.id);
    expect(result[0].companyName).toBe('Clinica Dental Orly');
    expect(result[0].primaryContactEmail).toBe('clinica-dental-orly@example.com');
    expect(result[0].onboardingStatus).toBe('live');
    expect(result[0].goLiveDate).toBe('2026-08-05T09:00:00.000Z');
    expect(result[0].stripeCustomerId).toBe('cus_orly_staging');
    expect(result[0].tier).toBe('pro');
  });

  it('maps DB columns email→primaryContactEmail, state→onboardingStatus, goLiveAt→goLiveDate', async () => {
    const result = await listAdminClients();
    expect(result[0]).toEqual({
      id: STAGING_CLINICA_DENTAL_ORLY.id,
      slug: STAGING_CLINICA_DENTAL_ORLY.id,
      companyName: 'Clinica Dental Orly',
      primaryContactEmail: 'clinica-dental-orly@example.com',
      stripeCustomerId: 'cus_orly_staging',
      tier: 'pro',
      onboardingStatus: 'live',
      createdAt: '2026-08-01T09:00:00.000Z',
      goLiveDate: '2026-08-05T09:00:00.000Z',
      chatbotSpaceId: null,
    });
  });

  it('queries Prisma with orderBy createdAt desc to mirror the operator landing page', async () => {
    await listAdminClients();
    expect(findMany).toHaveBeenCalledTimes(1);
    const arg = findMany.mock.calls[0][0] as {
      orderBy: { createdAt: string };
      where?: unknown;
    };
    expect(arg.orderBy).toEqual({ createdAt: 'desc' });
    expect(arg.where).toBeUndefined();
  });

  it('returns the live rows when findMany returns multiple seeded clients', async () => {
    findMany.mockResolvedValueOnce([STAGING_CLINICA_DENTAL_ORLY, STAGING_BRISA_BEACH]);
    const result = await listAdminClients();
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.id)).toEqual([
      STAGING_CLINICA_DENTAL_ORLY.id,
      STAGING_BRISA_BEACH.id,
    ]);
    expect(result[1].onboardingStatus).toBe('in-progress');
    expect(result[1].goLiveDate).toBeNull();
  });

  it('forwards the search arg as OR contains-insensitive on companyName OR email', async () => {
    await listAdminClients('orly');
    const arg = findMany.mock.calls[0][0] as {
      where?: { OR: Array<Record<string, { contains: string; mode: string }>> };
    };
    expect(arg.where).toBeDefined();
    expect(arg.where?.OR).toHaveLength(2);
    expect(arg.where?.OR[0]).toEqual({
      companyName: { contains: 'orly', mode: 'insensitive' },
    });
    expect(arg.where?.OR[1]).toEqual({
      email: { contains: 'orly', mode: 'insensitive' },
    });
  });

  it('omits the where clause when search is empty / whitespace-only', async () => {
    await listAdminClients('   ');
    const arg = findMany.mock.calls[0][0] as { where?: unknown };
    expect(arg.where).toBeUndefined();
  });

  // WP-23 — 'go-live-pending' used to be one of the "unknown" values this
  // exact test asserted got silently collapsed to 'in_progress' (the bug:
  // the old allowlist only recognized 'pending' | 'in_progress' | 'live' |
  // 'paused' | 'cancelled', so 3 of the 5 real state-machine values —
  // 'go-live-pending', 'ready', 'updating' — all landed on the same
  // default). It's now a recognized value in its own right.
  it('maps the real go-live-pending state through unchanged (not collapsed to in-progress)', async () => {
    findMany.mockResolvedValueOnce([
      { ...STAGING_CLINICA_DENTAL_ORLY, state: 'go-live-pending' },
    ]);
    const result = await listAdminClients();
    expect(result[0].onboardingStatus).toBe('go-live-pending');
  });

  it('maps a genuinely unrecognized state value to in-progress and logs an anomaly', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    findMany.mockResolvedValueOnce([
      { ...STAGING_CLINICA_DENTAL_ORLY, state: 'archived-legacy-2024' },
    ]);
    const result = await listAdminClients();
    expect(result[0].onboardingStatus).toBe('in-progress');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('archived-legacy-2024'));
    errorSpy.mockRestore();
  });

  it('returns [] (not the dev-mock fixtures) when findMany returns an empty array', async () => {
    findMany.mockResolvedValueOnce([]);
    const result = await listAdminClients();
    expect(result).toEqual([]);
  });

  it('returns [] when Prisma throws — never crash the operator session', async () => {
    findMany.mockRejectedValueOnce(new Error('connection terminated'));
    const result = await listAdminClients();
    expect(result).toEqual([]);
  });
});

describe('listAdminClients dev-mock mode (DATABASE_URL unset, KAIA-13715)', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    vi.resetModules();
    vi.doMock('@/lib/prisma', () => ({
      prisma: {
        chatbotClient: {
          findMany: (...args: unknown[]) => findMany(...args),
        },
      },
      isDatabaseConfigured: false,
    }));
    findMany.mockReset();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy?.mockRestore();
  });

  it('returns the three dev-mock fixtures when Prisma throws (no DB available)', async () => {
    // KAIA-13715 — the previous contract early-returned on
    // `!isDatabaseConfigured` BEFORE calling Prisma. That gate was
    // unreliable on Vercel production where `isDatabaseConfigured`
    // flipped per chunk. New contract: ALWAYS try Prisma first;
    // fall back to the mocks ONLY when the catch hits AND
    // `!isDatabaseConfigured` is true. With no DB available,
    // Prisma throws → catch fires → mocks returned.
    findMany.mockRejectedValueOnce(new Error('PrismaClientInitializationError'));
    const { listAdminClients: listMock } = await import('@/lib/portal-data');
    const result = await listMock();
    expect(result).toHaveLength(3);
    expect(result.map((c) => c.slug).sort()).toEqual(['acme-corp', 'globex-inc', 'starter-sl']);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('still returns the three dev-mock fixtures when Prisma throws AND a search arg is passed', async () => {
    findMany.mockRejectedValueOnce(new Error('PrismaClientInitializationError'));
    const { listAdminClients: listMock } = await import('@/lib/portal-data');
    const result = await listMock('orly');
    expect(result).toHaveLength(3);
    expect(result).toContainEqual(expect.objectContaining({ slug: MOCK_STARTER_CLIENT.slug }));
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('returns an empty list (not mocks) when Prisma throws on a configured DB — page renders EmptyState', async () => {
    // KAIA-13715 — production DB read errors must NOT silently swap to
    // mocks. The page already renders an explicit "Sin clientes"
    // empty state; that's the correct signal. This test re-runs under
    // the default `isDatabaseConfigured: true` mock above.
    vi.doUnmock('@/lib/prisma');
    vi.resetModules();
    const freshFindMany = vi.fn().mockRejectedValueOnce(new Error('connection refused'));
    vi.doMock('@/lib/prisma', () => ({
      prisma: {
        chatbotClient: {
          findMany: (...args: unknown[]) => freshFindMany(...args),
        },
      },
      isDatabaseConfigured: true,
    }));
    const { listAdminClients: listErr } = await import('@/lib/portal-data');
    const result = await listErr();
    expect(result).toEqual([]);
    expect(freshFindMany).toHaveBeenCalledTimes(1);
    vi.doUnmock('@/lib/prisma');
    vi.resetModules();
  });
});
