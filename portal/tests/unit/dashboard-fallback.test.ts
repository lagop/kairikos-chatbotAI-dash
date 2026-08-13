// =============================================================================
// KAIA-11641 — Unit tests for the dashboard non-Prisma fallback.
//
// Contract:
//
//   * `loadClientProfileViaPortalApi` returns the parsed JSON ClientProfile
//     when the inner fetch resolves with a 2xx response.
//   * It returns null when the inner fetch resolves with a non-2xx status.
//   * It returns null when the inner fetch throws.
//   * It returns null when no `PORTAL_API_BASE_URL` or
//     `NEXT_PUBLIC_PORTAL_URL` env var is set.
//   * It forwards the inbound cookies as a `cookie:` header so the
//     authenticated session reaches /api/portal/me. Without cookies the
//     route returns 401 and the helper collapses to null.
//
// KAIA-11891 — Cookie-scoping.
//   * When the configured base URL points to a different host than the
//     inbound request (e.g. Vercel preview with `NEXT_PUBLIC_PORTAL_URL`
//     set to the production alias), the helper falls back to the inbound
//     request's own origin. This keeps the forwarded session cookies on
//     the preview hostname and prevents `/api/portal/me` from returning
//     401 → MOCK_CLIENT regression.
//
// What's NOT tested here (lives in dashboard.staging.spec.ts):
//   * The end-to-end behaviour against the deployed Vercel preview with a
//     real Supabase auth round-trip. This unit test exercises the helper
//     in isolation; the e2e spec exercises the full redirect.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchMock = vi.fn();
const headerStore: Record<string, string> = {};

vi.mock('next/headers', () => ({
  cookies: () => ({
    getAll: () => [
      { name: 'kairikos-portal-session', value: 'sess-token-xyz' },
      { name: 'next-auth.csrf-token', value: 'csrf-abc' },
    ],
  }),
  headers: () => ({
    get: (name: string) => headerStore[name.toLowerCase()] ?? null,
  }),
}));

vi.stubGlobal('fetch', fetchMock);

import { loadClientProfileViaPortalApi } from '@/lib/dashboard-fallback';

function setInboundRequestHost(host: string, proto: string = 'https'): void {
  headerStore['host'] = host;
  headerStore['x-forwarded-host'] = host;
  headerStore['x-forwarded-proto'] = proto;
}

function clearInboundRequestHeaders(): void {
  for (const key of Object.keys(headerStore)) delete headerStore[key];
}

beforeEach(() => {
  fetchMock.mockReset();
  // The helper reads process.env.PORTAL_API_BASE_URL directly. Mirror the
  // value the mocked '@/lib/supabase' module exports so happy-path tests
  // see a configured environment. Tests that want the "no base URL"
  // branch delete the env var explicitly.
  process.env.PORTAL_API_BASE_URL = 'https://portal.example.test';
  // KAIA-11891: the tests below override these per-case; start from a
  // known-clean inbound-request header set so cookie-scoping tests are
  // deterministic.
  clearInboundRequestHeaders();
});

afterEach(() => {
  delete process.env.PORTAL_API_BASE_URL;
  delete process.env.NEXT_PUBLIC_PORTAL_URL;
  clearInboundRequestHeaders();
});

describe('loadClientProfileViaPortalApi', () => {
  it('returns the parsed JSON ClientProfile on a 2xx response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'cmsh9mzor00018zsgsfa97l6m',
        slug: 'orly.nityananda@gmail.com',
        companyName: 'Clinica dental Orly',
        primaryContactEmail: 'orly.nityananda@gmail.com',
        stripeCustomerId: null,
        tier: 'starter',
        onboardingStatus: 'in-progress',
        createdAt: '2026-08-06T08:40:29.739Z',
        goLiveDate: null,
        chatbotSpaceId: null,
        contactName: 'Clinica dental Orly',
      }),
    });

    const profile = await loadClientProfileViaPortalApi();
    expect(profile).not.toBeNull();
    expect(profile?.companyName).toBe('Clinica dental Orly');
    expect(profile?.tier).toBe('starter');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://portal.example.test/api/portal/me');
    expect(init.cache).toBe('no-store');
    expect(init.headers).toEqual({
      cookie: 'kairikos-portal-session=sess-token-xyz; next-auth.csrf-token=csrf-abc',
    });
  });

  it('returns null on a non-2xx response (e.g. 401 unauthorized)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: 'unauthorized' }),
    });

    const profile = await loadClientProfileViaPortalApi();
    expect(profile).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null when fetch throws (network error)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const profile = await loadClientProfileViaPortalApi();
    expect(profile).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null when no PORTAL_API_BASE_URL or NEXT_PUBLIC_PORTAL_URL is set', async () => {
    const savedBase = process.env.PORTAL_API_BASE_URL;
    const savedPortalUrl = process.env.NEXT_PUBLIC_PORTAL_URL;
    delete process.env.PORTAL_API_BASE_URL;
    delete process.env.NEXT_PUBLIC_PORTAL_URL;
    try {
      const profile = await loadClientProfileViaPortalApi();
      expect(profile).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (savedBase !== undefined) process.env.PORTAL_API_BASE_URL = savedBase;
      if (savedPortalUrl !== undefined) process.env.NEXT_PUBLIC_PORTAL_URL = savedPortalUrl;
    }
  });

  it('trims a trailing slash on the base URL before calling /api/portal/me', async () => {
    const savedBase = process.env.PORTAL_API_BASE_URL;
    process.env.PORTAL_API_BASE_URL = 'https://portal.example.test/';
    try {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'x', slug: 'x', companyName: 'Trim Co' }),
      });
      const profile = await loadClientProfileViaPortalApi();
      expect(profile?.companyName).toBe('Trim Co');
      const [url] = fetchMock.mock.calls[0]!;
      expect((url as string).endsWith('/api/portal/me')).toBe(true);
      expect((url as string).includes('//api/portal/me')).toBe(false);
      expect((url as string)).toBe('https://portal.example.test/api/portal/me');
    } finally {
      if (savedBase === undefined) delete process.env.PORTAL_API_BASE_URL;
      else process.env.PORTAL_API_BASE_URL = savedBase;
    }
  });

  it('uses the configured base URL when its host matches the inbound request', async () => {
    process.env.PORTAL_API_BASE_URL = 'https://portal.example.test';
    setInboundRequestHost('portal.example.test');

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: 'x', slug: 'x', companyName: 'Match Co' }),
    });

    const profile = await loadClientProfileViaPortalApi();
    expect(profile?.companyName).toBe('Match Co');
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://portal.example.test/api/portal/me');
  });

  // KAIA-11891: Vercel preview scenario. `NEXT_PUBLIC_PORTAL_URL` points
  // at the production alias; the inbound request lands on a preview
  // hostname. The helper must fall back to the inbound origin so cookies
  // stay scoped to the preview host and /api/portal/me returns 200.
  it('falls back to the inbound request origin when NEXT_PUBLIC_PORTAL_URL points to a different host (Vercel preview)', async () => {
    process.env.PORTAL_API_BASE_URL = '';
    process.env.NEXT_PUBLIC_PORTAL_URL = 'https://project-fxidg.vercel.app';
    setInboundRequestHost('kaia-4263-onboarding-wizard-abc123.vercel.app');

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'cmsh9mzor00018zsgsfa97l6m',
        slug: 'orly.nityananda@gmail.com',
        companyName: 'Clinica dental Orly',
        primaryContactEmail: 'orly.nityananda@gmail.com',
        stripeCustomerId: null,
        tier: 'starter',
        onboardingStatus: 'in-progress',
        createdAt: '2026-08-06T08:40:29.739Z',
        goLiveDate: null,
        chatbotSpaceId: null,
        contactName: 'Clinica dental Orly',
      }),
    });

    const profile = await loadClientProfileViaPortalApi();
    expect(profile?.companyName).toBe('Clinica dental Orly');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'https://kaia-4263-onboarding-wizard-abc123.vercel.app/api/portal/me',
    );
    expect(init.cache).toBe('no-store');
    // Cookies forwarded on the inbound-origin fallback path so the
    // session survives the cross-host alias otherwise configured.
    expect(init.headers).toEqual({
      cookie: 'kairikos-portal-session=sess-token-xyz; next-auth.csrf-token=csrf-abc',
    });
  });

  it('falls back to the inbound origin even when PORTAL_API_BASE_URL is set to a different host', async () => {
    process.env.PORTAL_API_BASE_URL = 'https://production-alias.example.com';
    delete process.env.NEXT_PUBLIC_PORTAL_URL;
    setInboundRequestHost('staging.example.test');

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: 'x', slug: 'x', companyName: 'Inbound Co' }),
    });

    const profile = await loadClientProfileViaPortalApi();
    expect(profile?.companyName).toBe('Inbound Co');
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://staging.example.test/api/portal/me');
  });

  it('honors x-forwarded-proto when resolving the inbound origin', async () => {
    process.env.PORTAL_API_BASE_URL = '';
    process.env.NEXT_PUBLIC_PORTAL_URL = 'https://project-fxidg.vercel.app';
    setInboundRequestHost('kaia-4263-onboarding-wizard-abc123.vercel.app', 'http');

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: 'x', slug: 'x', companyName: 'Proto Co' }),
    });

    const profile = await loadClientProfileViaPortalApi();
    expect(profile?.companyName).toBe('Proto Co');
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'http://kaia-4263-onboarding-wizard-abc123.vercel.app/api/portal/me',
    );
  });

  it('still uses the configured base when no inbound request host is available (background / non-RSC)', async () => {
    process.env.PORTAL_API_BASE_URL = 'https://portal.example.test';
    delete process.env.NEXT_PUBLIC_PORTAL_URL;
    clearInboundRequestHeaders();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: 'x', slug: 'x', companyName: 'Fallback Co' }),
    });

    const profile = await loadClientProfileViaPortalApi();
    expect(profile?.companyName).toBe('Fallback Co');
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://portal.example.test/api/portal/me');
  });

  it('returns null when no env var and no inbound host are available', async () => {
    delete process.env.PORTAL_API_BASE_URL;
    delete process.env.NEXT_PUBLIC_PORTAL_URL;
    clearInboundRequestHeaders();

    const profile = await loadClientProfileViaPortalApi();
    expect(profile).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
