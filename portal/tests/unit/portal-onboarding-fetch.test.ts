// =============================================================================
// KAIA-11955 — Unit tests for getOnboarding() path correctness.
//
// Bug:
//   getOnboarding() used to call `/portal/onboarding-status`, which is a
//   404 on the production Vercel deployment. The real GET route is
//   `/portal/onboarding` (see src/app/api/portal/onboarding/route.ts).
//   The 404 caused the customer-facing onboarding page to silently
//   fall back to the Acme mock fixture instead of the customer's real
//   (empty) timeline.
//
// Contract:
//   * getOnboarding() hits `${PORTAL_API_BASE_URL}/portal/onboarding`
//     (not `/portal/onboarding-status`).
//   * When the API returns `{ timeline: [] }` the function returns `[]`
//     (not the Acme MOCK_TIMELINE_INTERNAL fallback).
//   * When the API returns `{ timeline: [...] }` the function returns
//     that array verbatim.
//   * When the API call fails (non-2xx / network error) the function
//     falls back to MOCK_TIMELINE_INTERNAL — but ONLY in dev-mock mode
//     (i.e. no PORTAL_API_BASE_URL). In production, the real route
//     either returns data or 401, and the latter means the customer's
//     session is bad, which is a separate concern.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

vi.mock('@/lib/supabase', () => ({
  isBackendConfigured: true,
  PORTAL_API_BASE_URL: 'https://api.example.test/api',
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

  it('calls the canonical /portal/onboarding path, not the stale /portal/onboarding-status', async () => {
    mockApiResponse({ timeline: [] });
    await getOnboarding('test-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toMatch(/\/portal\/onboarding$/);
    expect(calledUrl).not.toMatch(/onboarding-status/);
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
