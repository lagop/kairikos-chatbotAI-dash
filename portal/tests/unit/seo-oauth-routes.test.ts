// =============================================================================
// SEO con IA, Fase B — unit tests for the Search Console OAuth routes:
//   GET /api/portal/seo/oauth/start
//   GET /api/portal/seo/oauth/callback
//
// Mirrors google-business-routes.test.ts's conventions. Focus: CSRF
// (state must round-trip through the cookie), the 'seo' product gate,
// and the no_site_url / site_not_verified guards specific to this
// route (a client's SeoProfile.siteUrl must be set AND match a
// verified Search Console property — never guessed).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const TEST_CLIENT_PRODUCT_ID = '11111111-1111-4111-8111-111111111111';

const mockState = vi.hoisted(() => ({
  resolveClientFromSession: vi.fn(),
  getSession: vi.fn(),
  isDatabaseConfigured: true,
  isSearchConsoleOAuthConfigured: vi.fn(),
  buildAuthorizationUrl: vi.fn(),
  exchangeCodeForTokens: vi.fn(),
  fetchVerifiedSites: vi.fn(),
  matchVerifiedSite: vi.fn(),
  encryptRefreshToken: vi.fn(),
  findUniqueClient: vi.fn(),
  findFirstProfile: vi.fn(),
  connectionUpsert: vi.fn(),
  isProductContracted: vi.fn(),
}));

vi.mock('@/lib/portal-session', () => ({
  resolveClientFromSession: (...args: unknown[]) => mockState.resolveClientFromSession(...args),
}));

vi.mock('@/lib/session', () => ({
  getSession: (...args: unknown[]) => mockState.getSession(...args),
}));

vi.mock('@/lib/client-product-access', () => ({
  isProductContracted: (...args: unknown[]) => mockState.isProductContracted(...args),
  // Fase 2 multi-instancia — la ruta resuelve ahora la contratación, no un
  // booleano. Se ata al mismo mock para no duplicar el estado de cada test.
  resolveContractedInstance: async () =>
    (await mockState.isProductContracted())
      ? {
          clientProductId: TEST_CLIENT_PRODUCT_ID,
          clientId: 'client_1',
          clientSiteId: null,
          tenantId: 'tenant_1',
          code: 'seo',
          tier: 'standard',
          status: 'active',
        }
      : null,
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    chatbotClient: { findUnique: (...args: unknown[]) => mockState.findUniqueClient(...args) },
    seoProfile: {
      findFirst: (...args: unknown[]) => mockState.findFirstProfile(...args),
      // Fase 2 multi-instancia — el callback busca el perfil por
      // clientProductId, no por cliente.
      findUnique: (...args: unknown[]) => mockState.findFirstProfile(...args),
    },
    googleSeoConnection: { upsert: (...args: unknown[]) => mockState.connectionUpsert(...args) },
  },
}));

vi.mock('@/lib/google-search-console', () => ({
  OAUTH_STATE_COOKIE: 'seo_gsc_oauth_state',
  isSearchConsoleOAuthConfigured: () => mockState.isSearchConsoleOAuthConfigured(),
  buildAuthorizationUrl: (...args: unknown[]) => mockState.buildAuthorizationUrl(...args),
  exchangeCodeForTokens: (...args: unknown[]) => mockState.exchangeCodeForTokens(...args),
  fetchVerifiedSites: (...args: unknown[]) => mockState.fetchVerifiedSites(...args),
  matchVerifiedSite: (...args: unknown[]) => mockState.matchVerifiedSite(...args),
  encryptRefreshToken: (...args: unknown[]) => mockState.encryptRefreshToken(...args),
}));

const RESOLVED = { clientId: 'client_1', email: 'a@b.com', source: 'database' as const };

beforeEach(() => {
  mockState.resolveClientFromSession.mockReset().mockResolvedValue(RESOLVED);
  mockState.getSession.mockReset().mockResolvedValue({ hasClientAccess: true });
  mockState.isDatabaseConfigured = true;
  mockState.isSearchConsoleOAuthConfigured.mockReset().mockReturnValue(true);
  mockState.buildAuthorizationUrl.mockReset().mockImplementation((state: string) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`);
  mockState.exchangeCodeForTokens.mockReset();
  mockState.fetchVerifiedSites.mockReset().mockResolvedValue([]);
  mockState.matchVerifiedSite.mockReset().mockReturnValue(null);
  mockState.encryptRefreshToken.mockReset().mockReturnValue({
    ciphertext: Buffer.from('ct'),
    iv: Buffer.from('iv'),
    tag: Buffer.from('tag'),
  });
  mockState.findUniqueClient.mockReset().mockResolvedValue({ tenantId: 'tenant_1' });
  mockState.findFirstProfile.mockReset().mockResolvedValue({ siteUrl: 'https://negocio.example' });
  mockState.connectionUpsert.mockReset().mockResolvedValue({ id: 'conn_1' });
  mockState.isProductContracted.mockReset().mockResolvedValue(true);
});

describe('GET /api/portal/seo/oauth/start', () => {
  function makeRequest(clientProductId?: string) {
    const url = new URL('https://portal.kairikos.test/api/portal/seo/oauth/start');
    if (clientProductId) url.searchParams.set('clientProductId', clientProductId);
    return { url: url.toString(), nextUrl: url } as unknown as NextRequest;
  }

  it('redirects to login when there is no session', async () => {
    mockState.getSession.mockResolvedValueOnce({ hasClientAccess: false });
    const { GET } = await import('@/app/api/portal/seo/oauth/start/route');
    const res = await GET(makeRequest());
    expect(res.headers.get('location')).toContain('/portal/login');
  });

  it('redirects with connect_error=not_available_in_dev_mode for a dev-mock session', async () => {
    mockState.resolveClientFromSession.mockResolvedValueOnce({ ...RESOLVED, source: 'mock_dev' });
    const { GET } = await import('@/app/api/portal/seo/oauth/start/route');
    const res = await GET(makeRequest());
    expect(res.headers.get('location')).toContain('connect_error=not_available_in_dev_mode');
  });

  it('redirects with connect_error=forbidden when the client has not contracted the seo product', async () => {
    mockState.isProductContracted.mockResolvedValueOnce(false);
    const { GET } = await import('@/app/api/portal/seo/oauth/start/route');
    const res = await GET(makeRequest());
    expect(res.headers.get('location')).toContain('connect_error=forbidden');
    expect(mockState.buildAuthorizationUrl).not.toHaveBeenCalled();
  });

  it('redirects with connect_error=not_configured when OAuth is not configured', async () => {
    mockState.isSearchConsoleOAuthConfigured.mockReturnValueOnce(false);
    const { GET } = await import('@/app/api/portal/seo/oauth/start/route');
    const res = await GET(makeRequest());
    expect(res.headers.get('location')).toContain('connect_error=not_configured');
  });

  it('manda a Google solo el nonce, y guarda la contratación en la cookie', async () => {
    // Fase 2 multi-instancia: la cookie httpOnly lleva "<nonce>:<contratación>"
    // y el parámetro state que ve Google es SOLO el nonce. Así el id no acaba
    // en los registros de Google ni en el historial del navegador, y la
    // comprobación CSRF sigue siendo la misma de antes.
    const { GET } = await import('@/app/api/portal/seo/oauth/start/route');
    const res = await GET(makeRequest());
    const cookie = res.cookies.get('seo_gsc_oauth_state');
    expect(cookie?.value).toBeTruthy();

    const [nonce, clientProductId] = (cookie?.value ?? '').split(':');
    expect(nonce).toBeTruthy();
    expect(clientProductId).toBe(TEST_CLIENT_PRODUCT_ID);

    const location = res.headers.get('location') ?? '';
    expect(location).toContain(`state=${nonce}`);
    expect(location).not.toContain(TEST_CLIENT_PRODUCT_ID);
  });
});

describe('GET /api/portal/seo/oauth/callback', () => {
  function makeRequest(params: Record<string, string>, cookieValue?: string) {
    const url = new URL('https://portal.kairikos.test/api/portal/seo/oauth/callback');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return {
      nextUrl: url,
      url: url.toString(),
      cookies: { get: (name: string) => (name === 'seo_gsc_oauth_state' && cookieValue ? { name, value: cookieValue } : undefined) },
    } as unknown as NextRequest;
  }

  it('rejects with connect_error=csrf when the state does not match the cookie', async () => {
    const { GET } = await import('@/app/api/portal/seo/oauth/callback/route');
    const res = await GET(makeRequest({ code: 'code_1', state: 'state_a' }, 'state_b'));
    expect(res.headers.get('location')).toContain('connect_error=csrf');
    expect(mockState.exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it('rejects with connect_error=csrf when there is no state cookie at all', async () => {
    const { GET } = await import('@/app/api/portal/seo/oauth/callback/route');
    const res = await GET(makeRequest({ code: 'code_1', state: 'state_a' }));
    expect(res.headers.get('location')).toContain('connect_error=csrf');
  });

  it('clears the state cookie on every outcome', async () => {
    const { GET } = await import('@/app/api/portal/seo/oauth/callback/route');
    const res = await GET(makeRequest({ code: 'code_1', state: 'state_a' }, 'state_a'));
    expect(res.cookies.get('seo_gsc_oauth_state')?.value).toBe('');
  });

  it('redirects with connect_error=no_site_url when SeoProfile has no siteUrl yet, without calling Google', async () => {
    mockState.findFirstProfile.mockResolvedValueOnce({ siteUrl: null });
    const { GET } = await import('@/app/api/portal/seo/oauth/callback/route');
    const res = await GET(makeRequest({ code: 'code_1', state: 'state_a' }, 'state_a'));
    expect(res.headers.get('location')).toContain('connect_error=no_site_url');
    expect(mockState.exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it('redirects with connect_error=no_site_url when there is no SeoProfile row at all', async () => {
    mockState.findFirstProfile.mockResolvedValueOnce(null);
    const { GET } = await import('@/app/api/portal/seo/oauth/callback/route');
    const res = await GET(makeRequest({ code: 'code_1', state: 'state_a' }, 'state_a'));
    expect(res.headers.get('location')).toContain('connect_error=no_site_url');
  });

  it('redirects with connect_error=token_exchange_failed when the code exchange fails', async () => {
    mockState.exchangeCodeForTokens.mockResolvedValueOnce(null);
    const { GET } = await import('@/app/api/portal/seo/oauth/callback/route');
    const res = await GET(makeRequest({ code: 'code_1', state: 'state_a' }, 'state_a'));
    expect(res.headers.get('location')).toContain('connect_error=token_exchange_failed');
  });

  it('redirects with connect_error=site_not_verified rather than guessing which property to connect', async () => {
    mockState.exchangeCodeForTokens.mockResolvedValueOnce({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresIn: 3600,
      scope: 'webmasters.readonly',
    });
    mockState.fetchVerifiedSites.mockResolvedValueOnce(['https://otro.example/']);
    mockState.matchVerifiedSite.mockReturnValueOnce(null);
    const { GET } = await import('@/app/api/portal/seo/oauth/callback/route');
    const res = await GET(makeRequest({ code: 'code_1', state: 'state_a' }, 'state_a'));
    expect(res.headers.get('location')).toContain('connect_error=site_not_verified');
    expect(mockState.connectionUpsert).not.toHaveBeenCalled();
  });

  it('creates the GoogleSeoConnection with the encrypted token parts and matched site on success', async () => {
    mockState.exchangeCodeForTokens.mockResolvedValueOnce({
      accessToken: 'at',
      refreshToken: 'rt_plain',
      expiresIn: 3600,
      scope: 'webmasters.readonly',
    });
    mockState.fetchVerifiedSites.mockResolvedValueOnce(['https://negocio.example/']);
    mockState.matchVerifiedSite.mockReturnValueOnce('https://negocio.example/');
    const { GET } = await import('@/app/api/portal/seo/oauth/callback/route');
    const res = await GET(makeRequest({ code: 'code_1', state: 'state_a' }, 'state_a'));

    expect(mockState.encryptRefreshToken).toHaveBeenCalledWith('rt_plain');
    expect(mockState.connectionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        // Fase 2 multi-instancia — la conexion se guarda contra la
        // contratacion, que es la que identifica la web.
        where: { clientProductId: TEST_CLIENT_PRODUCT_ID },
        create: expect.objectContaining({
          clientId: 'client_1',
          clientProductId: TEST_CLIENT_PRODUCT_ID,
          tenantId: 'tenant_1',
          searchConsoleSiteUrl: 'https://negocio.example/',
          refreshTokenCiphertext: Buffer.from('ct'),
          refreshTokenIv: Buffer.from('iv'),
          refreshTokenTag: Buffer.from('tag'),
          status: 'active',
        }),
      }),
    );
    expect(res.headers.get('location')).toContain('connected=1');
  });

  it('redirects with connect_error=no_tenant when the client row has no tenantId', async () => {
    mockState.exchangeCodeForTokens.mockResolvedValueOnce({
      accessToken: 'at',
      refreshToken: 'rt_plain',
      expiresIn: 3600,
      scope: 'webmasters.readonly',
    });
    mockState.fetchVerifiedSites.mockResolvedValueOnce(['https://negocio.example/']);
    mockState.matchVerifiedSite.mockReturnValueOnce('https://negocio.example/');
    mockState.findUniqueClient.mockResolvedValueOnce({ tenantId: null });
    const { GET } = await import('@/app/api/portal/seo/oauth/callback/route');
    const res = await GET(makeRequest({ code: 'code_1', state: 'state_a' }, 'state_a'));
    expect(res.headers.get('location')).toContain('connect_error=no_tenant');
    expect(mockState.connectionUpsert).not.toHaveBeenCalled();
  });

  it('redirects with connect_error=not_available_in_dev_mode when the database is not configured', async () => {
    mockState.isDatabaseConfigured = false;
    const { GET } = await import('@/app/api/portal/seo/oauth/callback/route');
    const res = await GET(makeRequest({ code: 'code_1', state: 'state_a' }, 'state_a'));
    expect(res.headers.get('location')).toContain('connect_error=not_available_in_dev_mode');
  });
});
