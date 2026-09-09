// =============================================================================
// SEO con IA, Fase 5 — unit tests for the WordPress self-serve connect
// routes:
//   GET /api/portal/seo/wordpress/connect
//   GET /api/portal/seo/wordpress/callback
//
// Mirrors seo-oauth-routes.test.ts's conventions (this is the same class
// of flow — a start route that redirects out, a callback that redirects
// back — just to WordPress's own authorize-application.php instead of
// Google's OAuth consent screen). Focus: the 'seo' product gate, the
// cmsType==='wordpress' + siteUrl preconditions, the CSRF state
// round-trip, and that the raw query string is never logged.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  resolveClientFromSession: vi.fn(),
  getSession: vi.fn(),
  isDatabaseConfigured: true,
  isProductContracted: vi.fn(),
  findFirstProfile: vi.fn(),
  encryptWordPressAppPassword: vi.fn(),
  profileUpdate: vi.fn(),
  auditCreate: vi.fn(),
  logError: vi.fn(),
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

vi.mock('@/lib/seo', () => ({
  encryptWordPressAppPassword: (...args: unknown[]) => mockState.encryptWordPressAppPassword(...args),
}));

vi.mock('@/lib/observability', () => ({
  logError: (...args: unknown[]) => mockState.logError(...args),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    seoProfile: {
      findFirst: (...args: unknown[]) => mockState.findFirstProfile(...args),
      update: (...args: unknown[]) => mockState.profileUpdate(...args),
    },
    seoProfileAudit: { create: (...args: unknown[]) => mockState.auditCreate(...args) },
    $transaction: (fn: (tx: unknown) => unknown) =>
      fn({
        seoProfile: { update: (...args: unknown[]) => mockState.profileUpdate(...args) },
        seoProfileAudit: { create: (...args: unknown[]) => mockState.auditCreate(...args) },
      }),
  },
}));

const RESOLVED = { clientId: 'client_1', email: 'a@b.com', source: 'database' as const };

beforeEach(() => {
  mockState.resolveClientFromSession.mockReset().mockResolvedValue(RESOLVED);
  mockState.getSession.mockReset().mockResolvedValue({ hasClientAccess: true });
  mockState.isDatabaseConfigured = true;
  mockState.isProductContracted.mockReset().mockResolvedValue(true);
  mockState.findFirstProfile.mockReset().mockResolvedValue({
    id: 'profile_1',
    tenantId: 'tenant_1',
    siteUrl: 'https://negocio.example',
    cmsType: 'wordpress',
    wordpressAppPasswordCiphertext: null,
    technicalSetupCompletedAt: null,
  });
  mockState.encryptWordPressAppPassword.mockReset().mockReturnValue({
    ciphertext: Buffer.from('ct'),
    iv: Buffer.from('iv'),
    tag: Buffer.from('tag'),
  });
  mockState.profileUpdate.mockReset().mockResolvedValue({});
  mockState.auditCreate.mockReset().mockResolvedValue({});
  mockState.logError.mockReset();
});

describe('GET /api/portal/seo/wordpress/connect', () => {
  function makeRequest() {
    return { url: 'https://portal.kairikos.test/api/portal/seo/wordpress/connect' } as unknown as NextRequest;
  }

  it('redirects to login when there is no session', async () => {
    mockState.getSession.mockResolvedValueOnce({ hasClientAccess: false });
    const { GET } = await import('@/app/api/portal/seo/wordpress/connect/route');
    const res = await GET(makeRequest());
    expect(res.headers.get('location')).toContain('/portal/login');
  });

  it('redirects with wp_connect_error=forbidden when seo is not contracted', async () => {
    mockState.isProductContracted.mockResolvedValueOnce(false);
    const { GET } = await import('@/app/api/portal/seo/wordpress/connect/route');
    const res = await GET(makeRequest());
    expect(res.headers.get('location')).toContain('wp_connect_error=forbidden');
  });

  it('redirects with wp_connect_error=no_site_url when the profile has no siteUrl', async () => {
    mockState.findFirstProfile.mockResolvedValueOnce({ siteUrl: null, cmsType: 'wordpress' });
    const { GET } = await import('@/app/api/portal/seo/wordpress/connect/route');
    const res = await GET(makeRequest());
    expect(res.headers.get('location')).toContain('wp_connect_error=no_site_url');
  });

  it('redirects with wp_connect_error=not_wordpress when the cms is not wordpress', async () => {
    mockState.findFirstProfile.mockResolvedValueOnce({ siteUrl: 'https://negocio.example', cmsType: 'wix' });
    const { GET } = await import('@/app/api/portal/seo/wordpress/connect/route');
    const res = await GET(makeRequest());
    expect(res.headers.get('location')).toContain('wp_connect_error=not_wordpress');
  });

  it('sets a state cookie and redirects to the wp-admin authorize-application URL carrying it via success_url', async () => {
    const { GET } = await import('@/app/api/portal/seo/wordpress/connect/route');
    const res = await GET(makeRequest());
    const cookie = res.cookies.get('seo_wp_connect_state');
    expect(cookie?.value).toBeTruthy();
    const location = res.headers.get('location') as string;
    expect(location).toContain('negocio.example/wp-admin/authorize-application.php');
    expect(decodeURIComponent(location)).toContain(`state=${cookie?.value}`);
  });
});

describe('GET /api/portal/seo/wordpress/callback', () => {
  function makeRequest(params: Record<string, string>, cookieValue?: string) {
    const url = new URL('https://portal.kairikos.test/api/portal/seo/wordpress/callback');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return {
      nextUrl: url,
      url: url.toString(),
      cookies: {
        get: (name: string) => (name === 'seo_wp_connect_state' && cookieValue ? { name, value: cookieValue } : undefined),
      },
    } as unknown as NextRequest;
  }

  const OK_PARAMS = { site_url: 'https://negocio.example', user_login: 'admin', password: 'xxxx xxxx xxxx xxxx', state: 'state_a' };

  it('redirects with wp_connect_error=csrf when the state does not match the cookie', async () => {
    const { GET } = await import('@/app/api/portal/seo/wordpress/callback/route');
    const res = await GET(makeRequest(OK_PARAMS, 'state_b'));
    expect(res.headers.get('location')).toContain('wp_connect_error=csrf');
    expect(mockState.profileUpdate).not.toHaveBeenCalled();
  });

  it('redirects with wp_connect_error=csrf when there is no state cookie at all', async () => {
    const { GET } = await import('@/app/api/portal/seo/wordpress/callback/route');
    const res = await GET(makeRequest(OK_PARAMS));
    expect(res.headers.get('location')).toContain('wp_connect_error=csrf');
  });

  it('clears the state cookie on every outcome', async () => {
    const { GET } = await import('@/app/api/portal/seo/wordpress/callback/route');
    const res = await GET(makeRequest(OK_PARAMS, 'state_a'));
    expect(res.cookies.get('seo_wp_connect_state')?.value).toBe('');
  });

  it('redirects with wp_connect_error=wordpress_incomplete_response when WordPress omitted a required field', async () => {
    const { GET } = await import('@/app/api/portal/seo/wordpress/callback/route');
    const res = await GET(makeRequest({ site_url: 'https://negocio.example', state: 'state_a' }, 'state_a'));
    expect(res.headers.get('location')).toContain('wp_connect_error=wordpress_incomplete_response');
    expect(mockState.profileUpdate).not.toHaveBeenCalled();
  });

  it('redirects with wp_connect_error=no_profile when the client has no SeoProfile row', async () => {
    mockState.findFirstProfile.mockResolvedValueOnce(null);
    const { GET } = await import('@/app/api/portal/seo/wordpress/callback/route');
    const res = await GET(makeRequest(OK_PARAMS, 'state_a'));
    expect(res.headers.get('location')).toContain('wp_connect_error=no_profile');
  });

  it('encrypts the password and saves wordpressUrl/wordpressUsername on success', async () => {
    const { GET } = await import('@/app/api/portal/seo/wordpress/callback/route');
    const res = await GET(makeRequest(OK_PARAMS, 'state_a'));

    expect(mockState.encryptWordPressAppPassword).toHaveBeenCalledWith('xxxx xxxx xxxx xxxx');
    expect(mockState.profileUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'profile_1' },
        data: expect.objectContaining({
          wordpressUrl: 'https://negocio.example',
          wordpressUsername: 'admin',
          wordpressAppPasswordCiphertext: Buffer.from('ct'),
          wordpressAppPasswordIv: Buffer.from('iv'),
          wordpressAppPasswordTag: Buffer.from('tag'),
        }),
      }),
    );
    expect(res.headers.get('location')).toContain('wp_connected=1');
  });

  it('writes an audit row attributed to the client, never to an operator, and never containing the password', async () => {
    const { GET } = await import('@/app/api/portal/seo/wordpress/callback/route');
    await GET(makeRequest(OK_PARAMS, 'state_a'));

    const auditCall = mockState.auditCreate.mock.calls[0][0];
    expect(auditCall.data.actorType).toBe('client');
    expect(auditCall.data.actorOperatorId).toBeNull();
    expect(auditCall.data.actorEmail).toBe('client:client_1');
    expect(JSON.stringify(auditCall.data)).not.toContain('xxxx xxxx xxxx xxxx');
  });

  it('stamps technicalSetupCompletedAt only the first time, not on a later reconnect', async () => {
    mockState.findFirstProfile.mockResolvedValueOnce({
      id: 'profile_1',
      tenantId: 'tenant_1',
      wordpressAppPasswordCiphertext: Buffer.from('old'),
      technicalSetupCompletedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const { GET } = await import('@/app/api/portal/seo/wordpress/callback/route');
    await GET(makeRequest(OK_PARAMS, 'state_a'));
    const data = mockState.profileUpdate.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('technicalSetupCompletedAt');
  });

  it('never logs the raw query string or the plaintext password on a failure', async () => {
    mockState.encryptWordPressAppPassword.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const { GET } = await import('@/app/api/portal/seo/wordpress/callback/route');
    const res = await GET(makeRequest(OK_PARAMS, 'state_a'));
    expect(res.headers.get('location')).toContain('wp_connect_error=internal_error');
    for (const call of mockState.logError.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('xxxx xxxx xxxx xxxx');
    }
  });

  it('redirects with wp_connect_error=not_available_in_dev_mode when the database is not configured', async () => {
    mockState.isDatabaseConfigured = false;
    const { GET } = await import('@/app/api/portal/seo/wordpress/callback/route');
    const res = await GET(makeRequest(OK_PARAMS, 'state_a'));
    expect(res.headers.get('location')).toContain('wp_connect_error=not_available_in_dev_mode');
  });
});
