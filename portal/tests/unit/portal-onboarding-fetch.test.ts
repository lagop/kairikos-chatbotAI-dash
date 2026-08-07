// =============================================================================
// KAIA-11955 — Unit tests for getOnboarding() path correctness and
// base-URL normalisation.
//
// Bug (round 1):
//   getOnboarding() used to call `/portal/onboarding-status`, which is a
//   404 on the production Vercel deployment. Fix: call `/portal/onboarding`.
//
// Bug (round 2, surfaced by board-user QA at 2026-08-07T11:48Z):
//   The fix in round 1 produced a correct-looking path that still 404s on
//   production because PORTAL_API_BASE_URL is set to
//   `https://project-fxidg.vercel.app/portal` (the SPA path) rather than
//   `https://project-fxidg.vercel.app/api` (where the route handlers live).
//   Building `${base}/portal/onboarding` gives a double
//   `/portal/portal/onboarding` and 404s. The fix: portalFetch() must
//   strip a trailing `/portal` from the base and translate
//   `/portal/...` paths to `/api/portal/...` so the request actually
//   reaches the real route at `${origin}/api/portal/onboarding`.
//
// Contract:
//   * When PORTAL_API_BASE_URL ends in `/portal`, fetch is called against
//     `${origin}/api${path}` for any `/portal/...` path.
//   * When PORTAL_API_BASE_URL is `${origin}/api` (the correct value), the
//     transformation is a no-op and the helper behaves exactly as before.
//   * When the API returns `{ timeline: [] }` the function returns `[]`
//     (not the Acme MOCK_TIMELINE_INTERNAL fallback).
//   * When the API returns `{ timeline: [...] }` the function returns
//     that array verbatim.
//   * The access token is forwarded as a Bearer header.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

vi.mock('@/lib/supabase', () => ({
  isBackendConfigured: true,
  PORTAL_API_BASE_URL: 'https://project-fxidg.vercel.app/portal',
  SUPABASE_ANON_KEY: 'anon-test',
}));

vi.stubGlobal('fetch', fetchMock);

import { getOnboarding } from '@/lib/portal-data';

function mockApiResponse(body: unknown, ok: boolean = true, status: number = 200): void {
  fetchMock.mockResolvedValueOnce({
    ok,
    status,
    json: async () => body,
  } as unknown as Response);
}

describe('getOnboarding (KAIA-11955)', () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  it('normalises the URL: base ends in /portal, path is /portal/onboarding → origin/api/portal/onboarding', async () => {
    mockApiResponse({ timeline: [] });
    await getOnboarding('test-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe('https://project-fxidg.vercel.app/api/portal/onboarding');
  });

  it('does NOT call the stale /portal/onboarding-status path', async () => {
    mockApiResponse({ timeline: [] });
    await getOnboarding('test-token');
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).not.toMatch(/onboarding-status/);
    // And the double-prefix bug must be gone:
    expect(calledUrl).not.toMatch(/\/portal\/portal\//);
  });

  it('forwards the access token as a Bearer header', async () => {
    mockApiResponse({ timeline: [] });
    await getOnboarding('access-token-xyz');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer access-token-xyz');
  });

  it('returns the API timeline verbatim when present (including empty array)', async () => {
    mockApiResponse({ timeline: [] });
    const result = await getOnboarding('test-token');
    expect(result).toEqual([]);
    expect(result.length).toBe(0);
  });

  it('returns the API timeline rows when non-empty', async () => {
    mockApiResponse({
      timeline: [
        {
          id: 'row-1',
          step: 't_plus_0',
          label: 'Bienvenida',
          description: 'Kickoff complete',
          occurredAt: '2026-08-06T08:40:30.965Z',
          status: 'done',
        },
      ],
    });
    const result = await getOnboarding('test-token');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('row-1');
    expect(result[0].status).toBe('done');
  });
});

describe('portalFetch URL normalisation (KAIA-11955 round 2)', () => {
  // We exercise the same portalFetch helper through getOnboarding and
  // getClientProfile so the test stays at the same layer the dashboard
  // uses. Both helpers call portalFetch with /portal/... paths.
  afterEach(() => fetchMock.mockReset());

  it('base = ".../portal" + path = "/portal/me" → origin/api/portal/me', async () => {
    // Re-import to re-evaluate the module-level env mocks.
    mockApiResponse({ id: 'x', email: 'a', name: 'A', companyName: 'A' });
    const { getClientProfile } = await import('@/lib/portal-data');
    await getClientProfile('token-1');
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe('https://project-fxidg.vercel.app/api/portal/me');
  });

  it('base = ".../portal" + path = "/portal/billing" → origin/api/portal/billing', async () => {
    mockApiResponse({ tier: 'pro' });
    const { getBilling } = await import('@/lib/portal-data');
    await getBilling('token-2');
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe('https://project-fxidg.vercel.app/api/portal/billing');
  });
});
