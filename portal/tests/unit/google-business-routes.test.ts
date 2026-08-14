// =============================================================================
// WP-21 — unit tests for the Google Business OAuth routes:
//   GET  /api/portal/google-business/oauth/start
//   GET  /api/portal/google-business/oauth/callback
//   POST /api/portal/google-business/disconnect
//
// Focus: the two security-critical properties the plan's ACs call out —
// CSRF (state must round-trip through the cookie) and connection
// ownership (a client can never disconnect someone else's row) — plus
// the multi-location safety decision (never silently pick one).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  resolveClientFromSession: vi.fn(),
  isDatabaseConfigured: true,
  isGoogleBusinessOAuthConfigured: vi.fn(),
  buildAuthorizationUrl: vi.fn(),
  exchangeCodeForTokens: vi.fn(),
  fetchAccessibleLocations: vi.fn(),
  encryptRefreshToken: vi.fn(),
  decryptRefreshToken: vi.fn(),
  revokeGoogleToken: vi.fn(),
  findUniqueClient: vi.fn(),
  connectionUpsert: vi.fn(),
  connectionFindUnique: vi.fn(),
  connectionUpdate: vi.fn(),
  isProductContracted: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/portal-session', () => ({
  resolveClientFromSession: (...args: unknown[]) => mockState.resolveClientFromSession(...args),
}));

vi.mock('@/lib/client-product-access', () => ({
  isProductContracted: (...args: unknown[]) => mockState.isProductContracted(...args),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    chatbotClient: { findUnique: (...args: unknown[]) => mockState.findUniqueClient(...args) },
    googleBusinessConnection: {
      upsert: (...args: unknown[]) => mockState.connectionUpsert(...args),
      findUnique: (...args: unknown[]) => mockState.connectionFindUnique(...args),
      update: (...args: unknown[]) => mockState.connectionUpdate(...args),
    },
  },
}));

vi.mock('@/lib/google-business', () => ({
  OAUTH_STATE_COOKIE: 'gb_oauth_state',
  isGoogleBusinessOAuthConfigured: () => mockState.isGoogleBusinessOAuthConfigured(),
  buildAuthorizationUrl: (...args: unknown[]) => mockState.buildAuthorizationUrl(...args),
  exchangeCodeForTokens: (...args: unknown[]) => mockState.exchangeCodeForTokens(...args),
  fetchAccessibleLocations: (...args: unknown[]) => mockState.fetchAccessibleLocations(...args),
  encryptRefreshToken: (...args: unknown[]) => mockState.encryptRefreshToken(...args),
  decryptRefreshToken: (...args: unknown[]) => mockState.decryptRefreshToken(...args),
  revokeGoogleToken: (...args: unknown[]) => mockState.revokeGoogleToken(...args),
}));

vi.mock('@/lib/observability', () => ({
  logError: (...args: unknown[]) => mockState.logError(...args),
}));

const RESOLVED = { clientId: 'client_1', email: 'a@b.com', source: 'database' as const };

beforeEach(() => {
  mockState.resolveClientFromSession.mockReset().mockResolvedValue(RESOLVED);
  mockState.isDatabaseConfigured = true;
  mockState.isGoogleBusinessOAuthConfigured.mockReset().mockReturnValue(true);
  mockState.buildAuthorizationUrl.mockReset().mockImplementation((state: string) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`);
  mockState.exchangeCodeForTokens.mockReset();
  mockState.fetchAccessibleLocations.mockReset();
  mockState.encryptRefreshToken.mockReset().mockReturnValue({
    ciphertext: Buffer.from('ct'),
    iv: Buffer.from('iv'),
    tag: Buffer.from('tag'),
  });
  mockState.decryptRefreshToken.mockReset().mockReturnValue('rt_plain');
  mockState.revokeGoogleToken.mockReset().mockResolvedValue(true);
  mockState.findUniqueClient.mockReset().mockResolvedValue({ tenantId: 'tenant_1' });
  mockState.connectionUpsert.mockReset().mockResolvedValue({ id: 'conn_1' });
  mockState.connectionFindUnique.mockReset();
  mockState.connectionUpdate.mockReset().mockResolvedValue({});
  mockState.isProductContracted.mockReset().mockResolvedValue(true);
  mockState.logError.mockReset();
});

describe('GET /api/portal/google-business/oauth/start', () => {
  function makeRequest() {
    return { url: 'https://portal.kairikos.test/api/portal/google-business/oauth/start' } as unknown as NextRequest;
  }

  it('redirects to login when there is no session', async () => {
    mockState.resolveClientFromSession.mockResolvedValueOnce(null);
    const { GET } = await import('@/app/api/portal/google-business/oauth/start/route');
    const res = await GET(makeRequest());
    expect(res.headers.get('location')).toContain('/portal/login');
  });

  it('redirects with connect_error for a dev-mock session', async () => {
    mockState.resolveClientFromSession.mockResolvedValueOnce({ ...RESOLVED, source: 'mock_dev' });
    const { GET } = await import('@/app/api/portal/google-business/oauth/start/route');
    const res = await GET(makeRequest());
    expect(res.headers.get('location')).toContain('connect_error=not_available_in_dev_mode');
  });

  it('redirects with connect_error=forbidden (WP-22a) when the client has not contracted the reviews product', async () => {
    mockState.isProductContracted.mockResolvedValueOnce(false);
    const { GET } = await import('@/app/api/portal/google-business/oauth/start/route');
    const res = await GET(makeRequest());
    expect(res.headers.get('location')).toContain('connect_error=forbidden');
    expect(mockState.buildAuthorizationUrl).not.toHaveBeenCalled();
  });

  it('redirects with connect_error when OAuth is not configured', async () => {
    mockState.isGoogleBusinessOAuthConfigured.mockReturnValueOnce(false);
    const { GET } = await import('@/app/api/portal/google-business/oauth/start/route');
    const res = await GET(makeRequest());
    expect(res.headers.get('location')).toContain('connect_error=not_configured');
  });

  it('sets a state cookie and redirects to the Google authorization URL carrying the same state', async () => {
    const { GET } = await import('@/app/api/portal/google-business/oauth/start/route');
    const res = await GET(makeRequest());
    const cookie = res.cookies.get('gb_oauth_state');
    expect(cookie?.value).toBeTruthy();
    expect(res.headers.get('location')).toContain(`state=${cookie?.value}`);
  });
});

describe('GET /api/portal/google-business/oauth/callback', () => {
  function makeRequest(params: Record<string, string>, cookieValue?: string) {
    const url = new URL('https://portal.kairikos.test/api/portal/google-business/oauth/callback');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return {
      nextUrl: url,
      url: url.toString(),
      cookies: { get: (name: string) => (name === 'gb_oauth_state' && cookieValue ? { name, value: cookieValue } : undefined) },
    } as unknown as NextRequest;
  }

  it('rejects with connect_error=csrf when the state does not match the cookie', async () => {
    const { GET } = await import('@/app/api/portal/google-business/oauth/callback/route');
    const res = await GET(makeRequest({ code: 'code_1', state: 'state_a' }, 'state_b'));
    expect(res.headers.get('location')).toContain('connect_error=csrf');
    expect(mockState.exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it('rejects with connect_error=csrf when there is no state cookie at all', async () => {
    const { GET } = await import('@/app/api/portal/google-business/oauth/callback/route');
    const res = await GET(makeRequest({ code: 'code_1', state: 'state_a' }));
    expect(res.headers.get('location')).toContain('connect_error=csrf');
  });

  it('clears the state cookie on every outcome', async () => {
    const { GET } = await import('@/app/api/portal/google-business/oauth/callback/route');
    const res = await GET(makeRequest({ code: 'code_1', state: 'state_a' }, 'state_a'));
    expect(res.cookies.get('gb_oauth_state')?.value).toBe('');
  });

  it('redirects with token_exchange_failed when the code exchange fails', async () => {
    mockState.exchangeCodeForTokens.mockResolvedValueOnce(null);
    const { GET } = await import('@/app/api/portal/google-business/oauth/callback/route');
    const res = await GET(makeRequest({ code: 'code_1', state: 'state_a' }, 'state_a'));
    expect(res.headers.get('location')).toContain('connect_error=token_exchange_failed');
  });

  it('redirects with no_locations when the connected account has zero locations', async () => {
    mockState.exchangeCodeForTokens.mockResolvedValueOnce({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600, scope: 'business.manage' });
    mockState.fetchAccessibleLocations.mockResolvedValueOnce([]);
    const { GET } = await import('@/app/api/portal/google-business/oauth/callback/route');
    const res = await GET(makeRequest({ code: 'code_1', state: 'state_a' }, 'state_a'));
    expect(res.headers.get('location')).toContain('connect_error=no_locations');
    expect(mockState.connectionUpsert).not.toHaveBeenCalled();
  });

  it('redirects with multiple_locations_unsupported rather than guessing which location to connect', async () => {
    mockState.exchangeCodeForTokens.mockResolvedValueOnce({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600, scope: 'business.manage' });
    mockState.fetchAccessibleLocations.mockResolvedValueOnce([
      { accountId: 'accounts/1', accountName: 'A', locationId: 'accounts/1/locations/1', locationName: 'Sede 1' },
      { accountId: 'accounts/1', accountName: 'A', locationId: 'accounts/1/locations/2', locationName: 'Sede 2' },
    ]);
    const { GET } = await import('@/app/api/portal/google-business/oauth/callback/route');
    const res = await GET(makeRequest({ code: 'code_1', state: 'state_a' }, 'state_a'));
    expect(res.headers.get('location')).toContain('connect_error=multiple_locations_unsupported');
    expect(mockState.connectionUpsert).not.toHaveBeenCalled();
  });

  it('creates the GoogleBusinessConnection with the encrypted token parts for a single-location account', async () => {
    mockState.exchangeCodeForTokens.mockResolvedValueOnce({ accessToken: 'at', refreshToken: 'rt_plain', expiresIn: 3600, scope: 'business.manage' });
    mockState.fetchAccessibleLocations.mockResolvedValueOnce([
      { accountId: 'accounts/1', accountName: 'Clínica Orly', locationId: 'accounts/1/locations/1', locationName: 'Sede Centro' },
    ]);
    const { GET } = await import('@/app/api/portal/google-business/oauth/callback/route');
    const res = await GET(makeRequest({ code: 'code_1', state: 'state_a' }, 'state_a'));

    expect(mockState.encryptRefreshToken).toHaveBeenCalledWith('rt_plain');
    expect(mockState.connectionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clientId_locationId: { clientId: 'client_1', locationId: 'accounts/1/locations/1' } },
        create: expect.objectContaining({
          clientId: 'client_1',
          tenantId: 'tenant_1',
          locationName: 'Sede Centro',
          refreshTokenCiphertext: Buffer.from('ct'),
          refreshTokenIv: Buffer.from('iv'),
          refreshTokenTag: Buffer.from('tag'),
          status: 'active',
        }),
      }),
    );
    expect(res.headers.get('location')).toContain('connected=1');
  });
});

describe('POST /api/portal/google-business/disconnect', () => {
  function makeRequest(body: unknown) {
    return { json: async () => body } as unknown as Parameters<
      typeof import('@/app/api/portal/google-business/disconnect/route').POST
    >[0];
  }
  const VALID_ID = '11111111-1111-1111-1111-111111111111';

  it('401s when there is no session', async () => {
    mockState.resolveClientFromSession.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/portal/google-business/disconnect/route');
    const res = await POST(makeRequest({ connectionId: VALID_ID }));
    expect(res.status).toBe(401);
  });

  it('404s when the connection belongs to a different client (ownership check)', async () => {
    mockState.connectionFindUnique.mockResolvedValueOnce({
      id: VALID_ID,
      clientId: 'someone_else',
      status: 'active',
      refreshTokenCiphertext: Buffer.from('ct'),
      refreshTokenIv: Buffer.from('iv'),
      refreshTokenTag: Buffer.from('tag'),
    });
    const { POST } = await import('@/app/api/portal/google-business/disconnect/route');
    const res = await POST(makeRequest({ connectionId: VALID_ID }));
    expect(res.status).toBe(404);
    expect(mockState.revokeGoogleToken).not.toHaveBeenCalled();
  });

  it('404s when the connection does not exist', async () => {
    mockState.connectionFindUnique.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/portal/google-business/disconnect/route');
    const res = await POST(makeRequest({ connectionId: VALID_ID }));
    expect(res.status).toBe(404);
  });

  it('revokes at Google and marks the row revoked for a valid owned connection', async () => {
    mockState.connectionFindUnique.mockResolvedValueOnce({
      id: VALID_ID,
      clientId: 'client_1',
      status: 'active',
      refreshTokenCiphertext: Buffer.from('ct'),
      refreshTokenIv: Buffer.from('iv'),
      refreshTokenTag: Buffer.from('tag'),
    });
    const { POST } = await import('@/app/api/portal/google-business/disconnect/route');
    const res = await POST(makeRequest({ connectionId: VALID_ID }));
    const body = await res.clone().json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ revoked: true, revokedAtGoogle: true });
    expect(mockState.revokeGoogleToken).toHaveBeenCalledWith('rt_plain');
    expect(mockState.connectionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: VALID_ID }, data: { status: 'revoked' } }),
    );
  });

  it('still marks the row revoked locally when the Google-side revoke fails (best-effort)', async () => {
    mockState.connectionFindUnique.mockResolvedValueOnce({
      id: VALID_ID,
      clientId: 'client_1',
      status: 'active',
      refreshTokenCiphertext: Buffer.from('ct'),
      refreshTokenIv: Buffer.from('iv'),
      refreshTokenTag: Buffer.from('tag'),
    });
    mockState.revokeGoogleToken.mockResolvedValueOnce(false);
    const { POST } = await import('@/app/api/portal/google-business/disconnect/route');
    const res = await POST(makeRequest({ connectionId: VALID_ID }));
    const body = await res.clone().json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ revoked: true, revokedAtGoogle: false });
    expect(mockState.connectionUpdate).toHaveBeenCalled();
  });

  it('short-circuits as already-revoked without calling Google again', async () => {
    mockState.connectionFindUnique.mockResolvedValueOnce({
      id: VALID_ID,
      clientId: 'client_1',
      status: 'revoked',
      refreshTokenCiphertext: Buffer.from('ct'),
      refreshTokenIv: Buffer.from('iv'),
      refreshTokenTag: Buffer.from('tag'),
    });
    const { POST } = await import('@/app/api/portal/google-business/disconnect/route');
    const res = await POST(makeRequest({ connectionId: VALID_ID }));
    const body = await res.clone().json();
    expect(body.alreadyRevoked).toBe(true);
    expect(mockState.revokeGoogleToken).not.toHaveBeenCalled();
    expect(mockState.connectionUpdate).not.toHaveBeenCalled();
  });
});
