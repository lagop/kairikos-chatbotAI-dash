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
// What's NOT tested here (lives in dashboard.staging.spec.ts):
//   * The end-to-end behaviour against the deployed Vercel preview with a
//     real Supabase auth round-trip. This unit test exercises the helper
//     in isolation; the e2e spec exercises the full redirect.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchMock = vi.fn();

vi.mock('next/headers', () => ({
  cookies: () => ({
    getAll: () => [
      { name: 'kairikos-portal-session', value: 'sess-token-xyz' },
      { name: 'next-auth.csrf-token', value: 'csrf-abc' },
    ],
  }),
}));

vi.stubGlobal('fetch', fetchMock);

import { loadClientProfileViaPortalApi } from '@/lib/dashboard-fallback';

beforeEach(() => {
  fetchMock.mockReset();
  // The helper reads process.env.PORTAL_API_BASE_URL directly. Mirror the
  // value the mocked '@/lib/supabase' module exports so happy-path tests
  // see a configured environment. Tests that want the "no base URL"
  // branch delete the env var explicitly.
  process.env.PORTAL_API_BASE_URL = 'https://portal.example.test';
});

afterEach(() => {
  delete process.env.PORTAL_API_BASE_URL;
  delete process.env.NEXT_PUBLIC_PORTAL_URL;
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
        onboardingStatus: 'in_progress',
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
});
