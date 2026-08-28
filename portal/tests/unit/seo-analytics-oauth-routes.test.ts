// =============================================================================
// SEO con IA — unit tests for the GA4/Analytics OAuth routes:
//   GET /api/portal/seo/analytics/oauth/start
//   GET /api/portal/seo/analytics/oauth/callback
//
// Mirrors seo-oauth-routes.test.ts's conventions. Unlike the Search
// Console callback, this one never checks siteUrl/site-matching — it
// always saves the connection as 'pending_property_selection' and lets
// the client pick a property afterwards (see the route's own header).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  resolveClientFromSession: vi.fn(),
  getSession: vi.fn(),
  isDatabaseConfigured: true,
  isAnalyticsOAuthConfigured: vi.fn(),
  buildAuthorizationUrl: vi.fn(),
  exchangeCodeForTokens: vi.fn(),
  encryptRefreshToken: vi.fn(),
  findUniqueClient: vi.fn(),
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
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    chatbotClient: { findUnique: (...args: unknown[]) => mockState.findUniqueClient(...args) },
    googleAnalyticsConnection: { upsert: (...args: unknown[]) => mockState.connectionUpsert(...args) },
  },
}));

vi.mock('@/lib/google-analytics', () => ({
  OAUTH_STATE_COOKIE: 'seo_ga4_oauth_state',
  isAnalyticsOAuthConfigured: () => mockState.isAnalyticsOAuthConfigured(),
  buildAuthorizationUrl: (...args: unknown[]) => mockState.buildAuthorizationUrl(...args),
  exchangeCodeForTokens: (...args: unknown[]) => mockState.exchangeCodeForTokens(...args),
  encryptRefreshToken: (...args: unknown[]) => mockState.encryptRefreshToken(...args),
}));

const RESOLVED = { clientId: 'client_1', email: 'a@b.com', source: 'database' as const };

beforeEach(() => {
  mockState.resolveClientFromSession.mockReset().mockResolvedValue(RESOLVED);
  mockState.getSession.mockReset().mockResolvedValue({ hasClientAccess: true });
  mockState.isDatabaseConfigured = true;
  mockState.isAnalyticsOAuthConfigured.mockReset().mockReturnValue(true);
  mockState.buildAuthorizationUrl.mockReset().mockImplementation((state: string) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`);
  mockState.exchangeCodeForTokens.mockReset();
  mockState.encryptRefreshToken.mockReset().mockReturnValue({
    ciphertext: Buffer.from('ct'),
    iv: Buffer.from('iv'),
    tag: Buffer.from('tag'),
  });
  mockState.findUniqueClient.mockReset().mockResolvedValue({ tenantId: 'tenant_1' });
  mockState.connectionUpsert.mockReset().mockResolvedValue({ id: 'conn_1' });
  mockState.isProductContracted.mockReset().mockResolvedValue(true);
});

describe('GET /api/portal/seo/analytics/oauth/start', () => {
  function makeRequest() {
    return { url: 'https://portal.kairikos.test/api/portal/seo/analytics/oauth/start' } as unknown as NextRequest;
  }

  it('redirects to login when there is no session', async () => {
    mockState.getSession.mockResolvedValueOnce({ hasClientAccess: false });
    const { GET } = await import('@/app/api/portal/seo/analytics/oauth/start/route');
    const res = await GET(makeRequest());
    expect(res.headers.get('location')).toContain('/portal/login');
  });

  it('redirects with ga_connect_error=forbidden when the client has not contracted seo', async () => {
    mockState.isProductContracted.mockResolvedValueOnce(false);
    const { GET } = await import('@/app/api/portal/seo/analytics/oauth/start/route');
    const res = await GET(makeRequest());
    expect(res.headers.get('location')).toContain('ga_connect_error=forbidden');
    expect(mockState.buildAuthorizationUrl).not.toHaveBeenCalled();
  });

  it('redirects with ga_connect_error=not_configured when OAuth is not configured', async () => {
    mockState.isAnalyticsOAuthConfigured.mockReturnValueOnce(false);
    const { GET } = await import('@/app/api/portal/seo/analytics/oauth/start/route');
    const res = await GET(makeRequest());
    expect(res.headers.get('location')).toContain('ga_connect_error=not_configured');
  });

  it('sets a state cookie and redirects to the Google authorization URL carrying the same state', async () => {
    const { GET } = await import('@/app/api/portal/seo/analytics/oauth/start/route');
    const res = await GET(makeRequest());
    const cookie = res.cookies.get('seo_ga4_oauth_state');
    expect(cookie?.value).toBeTruthy();
    expect(res.headers.get('location')).toContain(`state=${cookie?.value}`);
  });
});

describe('GET /api/portal/seo/analytics/oauth/callback', () => {
  function makeRequest(params: Record<string, string>, cookieValue?: string) {
    const url = new URL('https://portal.kairikos.test/api/portal/seo/analytics/oauth/callback');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return {
      nextUrl: url,
      url: url.toString(),
      cookies: { get: (name: string) => (name === 'seo_ga4_oauth_state' && cookieValue ? { name, value: cookieValue } : undefined) },
    } as unknown as NextRequest;
  }

  it('rejects with ga_connect_error=csrf when the state does not match the cookie', async () => {
    const { GET } = await import('@/app/api/portal/seo/analytics/oauth/callback/route');
    const res = await GET(makeRequest({ code: 'code_1', state: 'state_a' }, 'state_b'));
    expect(res.headers.get('location')).toContain('ga_connect_error=csrf');
    expect(mockState.exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it('clears the state cookie on every outcome', async () => {
    const { GET } = await import('@/app/api/portal/seo/analytics/oauth/callback/route');
    const res = await GET(makeRequest({ code: 'code_1', state: 'state_a' }, 'state_a'));
    expect(res.cookies.get('seo_ga4_oauth_state')?.value).toBe('');
  });

  it('redirects with ga_connect_error=token_exchange_failed when the code exchange fails', async () => {
    mockState.exchangeCodeForTokens.mockResolvedValueOnce(null);
    const { GET } = await import('@/app/api/portal/seo/analytics/oauth/callback/route');
    const res = await GET(makeRequest({ code: 'code_1', state: 'state_a' }, 'state_a'));
    expect(res.headers.get('location')).toContain('ga_connect_error=token_exchange_failed');
  });

  it('creates the connection as pending_property_selection — never guesses a property', async () => {
    mockState.exchangeCodeForTokens.mockResolvedValueOnce({
      accessToken: 'at',
      refreshToken: 'rt_plain',
      expiresIn: 3600,
      scope: 'analytics.readonly',
    });
    const { GET } = await import('@/app/api/portal/seo/analytics/oauth/callback/route');
    const res = await GET(makeRequest({ code: 'code_1', state: 'state_a' }, 'state_a'));

    expect(mockState.encryptRefreshToken).toHaveBeenCalledWith('rt_plain');
    expect(mockState.connectionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clientId: 'client_1' },
        create: expect.objectContaining({
          clientId: 'client_1',
          tenantId: 'tenant_1',
          status: 'pending_property_selection',
          refreshTokenCiphertext: Buffer.from('ct'),
        }),
      }),
    );
    expect(res.headers.get('location')).toContain('ga_connected=1');
  });

  it('reconnecting clears any previously selected property (a fresh grant may be a different account)', async () => {
    mockState.exchangeCodeForTokens.mockResolvedValueOnce({
      accessToken: 'at',
      refreshToken: 'rt_plain',
      expiresIn: 3600,
      scope: 'analytics.readonly',
    });
    const { GET } = await import('@/app/api/portal/seo/analytics/oauth/callback/route');
    await GET(makeRequest({ code: 'code_1', state: 'state_a' }, 'state_a'));
    expect(mockState.connectionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ propertyId: null, propertyDisplayName: null, status: 'pending_property_selection' }),
      }),
    );
  });

  it('redirects with ga_connect_error=no_tenant when the client row has no tenantId', async () => {
    mockState.exchangeCodeForTokens.mockResolvedValueOnce({
      accessToken: 'at',
      refreshToken: 'rt_plain',
      expiresIn: 3600,
      scope: 'analytics.readonly',
    });
    mockState.findUniqueClient.mockResolvedValueOnce({ tenantId: null });
    const { GET } = await import('@/app/api/portal/seo/analytics/oauth/callback/route');
    const res = await GET(makeRequest({ code: 'code_1', state: 'state_a' }, 'state_a'));
    expect(res.headers.get('location')).toContain('ga_connect_error=no_tenant');
    expect(mockState.connectionUpsert).not.toHaveBeenCalled();
  });

  it('redirects with ga_connect_error=not_available_in_dev_mode when the database is not configured', async () => {
    mockState.isDatabaseConfigured = false;
    const { GET } = await import('@/app/api/portal/seo/analytics/oauth/callback/route');
    const res = await GET(makeRequest({ code: 'code_1', state: 'state_a' }, 'state_a'));
    expect(res.headers.get('location')).toContain('ga_connect_error=not_available_in_dev_mode');
  });
});
