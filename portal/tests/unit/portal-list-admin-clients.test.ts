// =============================================================================
// KAIA-13680 — listAdminClients() must follow the same backend-configured
// gate as the sibling admin API route at
// `app/api/admin/portal/clients/route.ts:11`. The previous version
// returned the three dev-mock fixtures unconditionally, so the page at
// `/admin/portal/clients` rendered only the Acme / Globex / Starter mocks
// even on a Prisma-backed staging deployment (e.g. the seeded
// `clinica-dental-orly` row). After this fix:
//
//   * When `PORTAL_API_BASE_URL` is set (`isBackendConfigured`),
//     `listAdminClients()` fetches the local Next.js route
//     `/api/admin/portal/clients` and returns the upstream JSON. The
//     inbound cookies + an operator Bearer + the `X-Kairikos-Operator`
//     flag are forwarded so the upstream proxy at
//     `route.ts:11` recognises the operator. Non-2xx and parse errors
//     fall back to the three mocks so a stale stage mirror cannot 500
//     the page.
//
//   * When `PORTAL_API_BASE_URL` is unset (`!isBackendConfigured`,
//     local `next dev` without a backend), `listAdminClients()` returns
//     the three dev-mock fixtures directly so unit / smoke tests keep
//     rendering the local fixtures.
//
//   * Return type stays `Promise<ChatbotClient[]>` — the page shape is
//     unchanged.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

vi.mock('@/lib/supabase', () => ({
  isBackendConfigured: true,
  PORTAL_API_BASE_URL: 'https://api.kairikos.example.com',
  SUPABASE_ANON_KEY: 'anon-test',
}));

vi.mock('@/lib/session', () => ({
  getSession: async () => ({
    email: 'operator@example.com',
    accessToken: 'operator-dev',
    userId: 'op-1',
    role: 'operator',
    hasClientAccess: false,
    isOperator: true,
    clientSlug: null,
    clientId: null,
  }),
}));

vi.stubGlobal('fetch', fetchMock);

function mockApiResponse(body: unknown, ok: boolean = true, status: number = 200): void {
  fetchMock.mockResolvedValueOnce({
    ok,
    status,
    json: async () => body,
  } as unknown as Response);
}

import { listAdminClients, MOCK_STARTER_CLIENT } from '@/lib/portal-data';

const STAGING_CLINICA_DENTAL_ORLY = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'clinica-dental-orly',
  companyName: 'Clinica Dental Orly',
  primaryContactEmail: 'clinica-dental-orly@example.com',
  stripeCustomerId: 'cus_orly_staging',
  tier: 'pro',
  onboardingStatus: 'live',
  createdAt: '2026-08-01T09:00:00.000Z',
  goLiveDate: '2026-08-05T09:00:00.000Z',
  chatbotSpaceId: 'spc_clinica_dental_orly',
};

describe('listAdminClients (KAIA-13680)', () => {
  afterEach(() => {
    fetchMock.mockReset();
    vi.resetModules();
  });

  beforeEach(() => {
    vi.doMock('next/headers', () => ({
      headers: () => ({
        get: (name: string) => {
          const low = name.toLowerCase();
          if (low === 'cookie') return 'kairikos-portal-operator=1; authjs.session-token=sess-staging';
          if (low === 'host') return 'portal.kairikos.example.com';
          return null;
        },
      }),
    }));
  });

  it('returns upstream ChatbotClient[] when the local admin route returns 200 with one row (clinica dental orly)', async () => {
    mockApiResponse([STAGING_CLINICA_DENTAL_ORLY]);
    const result = await listAdminClients();
    expect(result).toEqual([STAGING_CLINICA_DENTAL_ORLY]);
    expect(result[0].slug).toBe('clinica-dental-orly');
    expect(result[0].companyName).toBe('Clinica Dental Orly');
  });

  it('calls the LOCAL Next.js route /api/admin/portal/clients, not the upstream PORTAL_API_BASE_URL URL', async () => {
    mockApiResponse([STAGING_CLINICA_DENTAL_ORLY]);
    await listAdminClients();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toMatch(/^https?:\/\/[^/]+\/api\/admin\/portal\/clients$/);
    expect(calledUrl).not.toMatch(/api\.kairikos\.example\.com/);
  });

  it('forwards the inbound operator cookie to the local route so the upstream proxy recognises the operator', async () => {
    mockApiResponse([STAGING_CLINICA_DENTAL_ORLY]);
    await listAdminClients();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.cookie).toContain('kairikos-portal-operator=1');
    expect(headers.cookie).toContain('authjs.session-token=sess-staging');
  });

  it('forwards the X-Kairikos-Operator header so the upstream route treats the caller as staff', async () => {
    mockApiResponse([STAGING_CLINICA_DENTAL_ORLY]);
    await listAdminClients();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Kairikos-Operator']).toBe('1');
  });

  it('sets cache: "no-store" so subsequent renders see fresh client rows', async () => {
    mockApiResponse([STAGING_CLINICA_DENTAL_ORLY]);
    await listAdminClients();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.cache).toBe('no-store');
  });

  it('returns the upstream rows when the local route returns multiple rows', async () => {
    mockApiResponse([
      STAGING_CLINICA_DENTAL_ORLY,
      {
        ...STAGING_CLINICA_DENTAL_ORLY,
        id: '22222222-2222-4222-8222-222222222222',
        slug: 'brisa-beach-houses',
        companyName: 'Brisa Beach Houses',
      },
    ]);
    const result = await listAdminClients();
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.slug)).toEqual(['clinica-dental-orly', 'brisa-beach-houses']);
  });

  it('falls back to the three dev-mock fixtures when the local route returns 500 (so the page never 500s)', async () => {
    mockApiResponse({ error: 'upstream-down' }, false, 500);
    const result = await listAdminClients();
    expect(result).toHaveLength(3);
    expect(result.map((c) => c.slug).sort()).toEqual(['acme-corp', 'globex-inc', 'starter-sl']);
  });

  it('falls back to the three dev-mock fixtures when fetch itself throws (network down)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await listAdminClients();
    expect(result).toHaveLength(3);
    expect(result).toContainEqual(expect.objectContaining({ slug: MOCK_STARTER_CLIENT.slug }));
  });

  it('returns an empty array (not the dev-mock fixtures) when the local route returns an empty 200 array', async () => {
    // Real backend with zero seeded clients is a legitimate empty state
    // — the page renders EmptyState. Returning the three mocks here
    // would silently mask a missing seed.
    mockApiResponse([]);
    const result = await listAdminClients();
    expect(result).toEqual([]);
  });
});

describe('listAdminClients dev-mock mode (PORTAL_API_BASE_URL unset, KAIA-13680)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('@/lib/supabase', () => ({
      isBackendConfigured: false,
      PORTAL_API_BASE_URL: '',
      SUPABASE_ANON_KEY: 'anon-test',
    }));
  });

  it('returns the three dev-mock fixtures without making any network request', async () => {
    const { listAdminClients: listMock } = await import('@/lib/portal-data');
    const result = await listMock();
    expect(result).toHaveLength(3);
    expect(result.map((c) => c.slug).sort()).toEqual(['acme-corp', 'globex-inc', 'starter-sl']);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
