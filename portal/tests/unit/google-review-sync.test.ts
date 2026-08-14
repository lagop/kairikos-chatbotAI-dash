// =============================================================================
// WP-22a — unit tests for src/lib/google-review-sync.ts.
//
// Covers: idempotent upsert by googleReviewId (a repeated sync never
// duplicates a row), star-rating enum→int mapping, pagination, the
// quota-respecting min-interval guard shared by the manual-sync route
// and the cron sweep, and per-connection error isolation in the sweep.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  fetch: vi.fn(),
  getValidAccessToken: vi.fn(),
  reviewUpsert: vi.fn(),
  connectionUpdate: vi.fn(),
  connectionFindMany: vi.fn(),
  logError: vi.fn(),
}));

vi.stubGlobal('fetch', mockState.fetch);

vi.mock('@/lib/google-business', () => ({
  getValidAccessToken: (...args: unknown[]) => mockState.getValidAccessToken(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    googleReview: { upsert: (...args: unknown[]) => mockState.reviewUpsert(...args) },
    googleBusinessConnection: {
      update: (...args: unknown[]) => mockState.connectionUpdate(...args),
      findMany: (...args: unknown[]) => mockState.connectionFindMany(...args),
    },
  },
}));

vi.mock('@/lib/observability', () => ({
  logError: (...args: unknown[]) => mockState.logError(...args),
}));

import { isSyncDue, syncReviewsForConnection, syncAllDueConnections } from '@/lib/google-review-sync';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

function baseConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn_1',
    clientId: 'client_1',
    tenantId: 'tenant_1',
    googleAccountId: 'accounts/123',
    locationId: 'locations/456',
    locationName: 'Sede Centro',
    status: 'active',
    lastSyncAt: null,
    lastSyncError: null,
    refreshTokenCiphertext: Buffer.from('ct'),
    refreshTokenIv: Buffer.from('iv'),
    refreshTokenTag: Buffer.from('tag'),
    ...overrides,
  } as never;
}

beforeEach(() => {
  mockState.fetch.mockReset();
  mockState.getValidAccessToken.mockReset().mockResolvedValue('at_1');
  mockState.reviewUpsert.mockReset().mockResolvedValue({});
  mockState.connectionUpdate.mockReset().mockResolvedValue({});
  mockState.connectionFindMany.mockReset();
  mockState.logError.mockReset();
  delete process.env.GOOGLE_REVIEWS_SYNC_MIN_INTERVAL_MINUTES;
});

afterEach(() => {
  delete process.env.GOOGLE_REVIEWS_SYNC_MIN_INTERVAL_MINUTES;
});

describe('isSyncDue', () => {
  it('is due when there is no prior sync', () => {
    expect(isSyncDue(null)).toBe(true);
  });

  it('is NOT due within the default 60-minute interval', () => {
    expect(isSyncDue(new Date(Date.now() - 10 * 60_000))).toBe(false);
  });

  it('is due once the configured interval has elapsed', () => {
    process.env.GOOGLE_REVIEWS_SYNC_MIN_INTERVAL_MINUTES = '5';
    expect(isSyncDue(new Date(Date.now() - 6 * 60_000))).toBe(true);
  });
});

describe('syncReviewsForConnection — guards', () => {
  it('skips a non-active connection without calling Google', async () => {
    const result = await syncReviewsForConnection(baseConnection({ status: 'needs_reconnect' }));
    expect(result).toEqual({ synced: false, reason: 'not_active' });
    expect(mockState.getValidAccessToken).not.toHaveBeenCalled();
  });

  it('skips a too-recent sync unless forced', async () => {
    const result = await syncReviewsForConnection(baseConnection({ lastSyncAt: new Date() }));
    expect(result).toEqual({ synced: false, reason: 'too_recent' });
    expect(mockState.getValidAccessToken).not.toHaveBeenCalled();
  });

  it('runs anyway when forced, even if recently synced', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ reviews: [] }));
    const result = await syncReviewsForConnection(baseConnection({ lastSyncAt: new Date() }), { force: true });
    expect(result.synced).toBe(true);
  });

  it('returns no_access_token when getValidAccessToken fails (already handled degraded state internally)', async () => {
    mockState.getValidAccessToken.mockResolvedValueOnce(null);
    const result = await syncReviewsForConnection(baseConnection());
    expect(result).toEqual({ synced: false, reason: 'no_access_token' });
    expect(mockState.fetch).not.toHaveBeenCalled();
  });
});

describe('syncReviewsForConnection — Reviews API v4 parent path', () => {
  it('builds the parent from googleAccountId + locationId (v4 shape, not the v1 location resource name alone)', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ reviews: [] }));
    await syncReviewsForConnection(baseConnection());
    const calledUrl = mockState.fetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/v4/accounts/123/locations/456/reviews');
  });
});

describe('syncReviewsForConnection — idempotent upsert + star rating mapping', () => {
  it('upserts each review by its full resource name (googleReviewId) and maps the enum star rating', async () => {
    mockState.fetch.mockResolvedValueOnce(
      jsonResponse({
        reviews: [
          {
            name: 'accounts/123/locations/456/reviews/r1',
            reviewer: { displayName: 'Ana' },
            starRating: 'FIVE',
            comment: 'Genial',
            createTime: '2026-08-01T10:00:00Z',
            updateTime: '2026-08-01T10:00:00Z',
          },
        ],
      }),
    );
    const result = await syncReviewsForConnection(baseConnection());

    expect(result).toEqual({ synced: true, reviewCount: 1 });
    expect(mockState.reviewUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { googleReviewId: 'accounts/123/locations/456/reviews/r1' },
        create: expect.objectContaining({ starRating: 5, reviewerName: 'Ana', comment: 'Genial' }),
      }),
    );
  });

  it('a second sync run on the same review upserts (not inserts) — never a duplicate row', async () => {
    const review = {
      name: 'accounts/123/locations/456/reviews/r1',
      starRating: 'THREE',
      createTime: '2026-08-01T10:00:00Z',
      updateTime: '2026-08-02T10:00:00Z',
    };
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ reviews: [review] }));
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ reviews: [review] }));

    await syncReviewsForConnection(baseConnection());
    await syncReviewsForConnection(baseConnection(), { force: true });

    expect(mockState.reviewUpsert).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = mockState.reviewUpsert.mock.calls;
    expect(firstCall[0].where).toEqual(secondCall[0].where);
  });

  it('skips a review entry missing required fields rather than upserting a broken row', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ reviews: [{ starRating: 'FIVE' }] }));
    const result = await syncReviewsForConnection(baseConnection());
    expect(result.reviewCount).toBe(0);
    expect(mockState.reviewUpsert).not.toHaveBeenCalled();
  });
});

describe('syncReviewsForConnection — pagination', () => {
  it('follows nextPageToken until it is absent, aggregating the review count', async () => {
    mockState.fetch
      .mockResolvedValueOnce(
        jsonResponse({
          reviews: [{ name: 'r1', starRating: 'FIVE', createTime: '2026-08-01T10:00:00Z', updateTime: '2026-08-01T10:00:00Z' }],
          nextPageToken: 'page2',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          reviews: [{ name: 'r2', starRating: 'FOUR', createTime: '2026-08-02T10:00:00Z', updateTime: '2026-08-02T10:00:00Z' }],
        }),
      );
    const result = await syncReviewsForConnection(baseConnection());
    expect(result).toEqual({ synced: true, reviewCount: 2 });
    expect(mockState.fetch.mock.calls[1][0]).toContain('pageToken=page2');
  });
});

describe('syncReviewsForConnection — failure handling', () => {
  it('records lastSyncError and does not throw when the API call fails', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({}, false, 500));
    const result = await syncReviewsForConnection(baseConnection());
    expect(result).toEqual({ synced: false, reason: 'api_error' });
    expect(mockState.connectionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastSyncError: expect.stringContaining('500') }) }),
    );
  });

  it('clears lastSyncError on a subsequent successful sync', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ reviews: [] }));
    await syncReviewsForConnection(baseConnection());
    expect(mockState.connectionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastSyncError: null }) }),
    );
  });
});

describe('syncAllDueConnections', () => {
  it('only syncs connections whose sync is due, and isolates a failure to one connection', async () => {
    mockState.connectionFindMany.mockResolvedValueOnce([
      baseConnection({ id: 'due_1', lastSyncAt: null }),
      baseConnection({ id: 'not_due', lastSyncAt: new Date() }),
      baseConnection({ id: 'due_2_fails', lastSyncAt: null }),
    ]);
    mockState.fetch
      .mockResolvedValueOnce(jsonResponse({ reviews: [] })) // due_1 succeeds
      .mockResolvedValueOnce(jsonResponse({}, false, 500)); // due_2_fails fails

    const result = await syncAllDueConnections();
    expect(result).toEqual({ swept: 3, synced: 1 });
    // Only 2 fetch calls — 'not_due' never triggers a Google API call.
    expect(mockState.fetch).toHaveBeenCalledTimes(2);
  });
});
