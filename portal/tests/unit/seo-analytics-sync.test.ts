// =============================================================================
// SEO con IA — unit tests for src/lib/seo-analytics-sync.ts.
//
// Mirrors seo-search-console-sync.test.ts's conventions closely.
// Covers: the coarse (24h default) min-interval guard, the
// YYYYMMDD-response-vs-YYYY-MM-DD-request date format handling
// (GA4-specific quirk, not a typo — see the module's own header),
// idempotent upsert by (connectionId, date), and failure handling.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  fetch: vi.fn(),
  getValidAccessToken: vi.fn(),
  metricUpsert: vi.fn(),
  connectionUpdate: vi.fn(),
  connectionFindMany: vi.fn(),
  logError: vi.fn(),
}));

vi.stubGlobal('fetch', mockState.fetch);

vi.mock('@/lib/google-analytics', () => ({
  getValidAccessToken: (...args: unknown[]) => mockState.getValidAccessToken(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    seoAnalyticsMetric: { upsert: (...args: unknown[]) => mockState.metricUpsert(...args) },
    googleAnalyticsConnection: {
      update: (...args: unknown[]) => mockState.connectionUpdate(...args),
      findMany: (...args: unknown[]) => mockState.connectionFindMany(...args),
    },
  },
}));

vi.mock('@/lib/observability', () => ({
  logError: (...args: unknown[]) => mockState.logError(...args),
}));

import { isSyncDue, syncAnalyticsForConnection, syncAllDueConnections } from '@/lib/seo-analytics-sync';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

function baseConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn_1',
    clientId: 'client_1',
    tenantId: 'tenant_1',
    propertyId: 'properties/1000',
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
  mockState.metricUpsert.mockReset().mockResolvedValue({});
  mockState.connectionUpdate.mockReset().mockResolvedValue({});
  mockState.connectionFindMany.mockReset();
  mockState.logError.mockReset();
  delete process.env.SEO_ANALYTICS_SYNC_MIN_INTERVAL_HOURS;
});

afterEach(() => {
  delete process.env.SEO_ANALYTICS_SYNC_MIN_INTERVAL_HOURS;
});

describe('isSyncDue', () => {
  it('is due when there is no prior sync', () => {
    expect(isSyncDue(null)).toBe(true);
  });

  it('is NOT due within the default 24-hour interval', () => {
    expect(isSyncDue(new Date(Date.now() - 60 * 60_000))).toBe(false);
  });

  it('is due once the configured interval has elapsed', () => {
    process.env.SEO_ANALYTICS_SYNC_MIN_INTERVAL_HOURS = '1';
    expect(isSyncDue(new Date(Date.now() - 2 * 60 * 60_000))).toBe(true);
  });
});

describe('syncAnalyticsForConnection — guards', () => {
  it('skips a non-active connection without calling Google', async () => {
    const result = await syncAnalyticsForConnection(baseConnection({ status: 'needs_reconnect' }));
    expect(result).toEqual({ synced: false, reason: 'not_active' });
    expect(mockState.getValidAccessToken).not.toHaveBeenCalled();
  });

  it('skips a connection with no propertyId (still pending selection) without calling Google', async () => {
    const result = await syncAnalyticsForConnection(baseConnection({ propertyId: null }));
    expect(result).toEqual({ synced: false, reason: 'not_active' });
    expect(mockState.getValidAccessToken).not.toHaveBeenCalled();
  });

  it('skips a too-recent sync unless forced', async () => {
    const result = await syncAnalyticsForConnection(baseConnection({ lastSyncAt: new Date() }));
    expect(result).toEqual({ synced: false, reason: 'too_recent' });
    expect(mockState.getValidAccessToken).not.toHaveBeenCalled();
  });

  it('runs anyway when forced, even if recently synced', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ rows: [] }));
    const result = await syncAnalyticsForConnection(baseConnection({ lastSyncAt: new Date() }), { force: true });
    expect(result.synced).toBe(true);
  });

  it('returns no_access_token when getValidAccessToken fails', async () => {
    mockState.getValidAccessToken.mockResolvedValueOnce(null);
    const result = await syncAnalyticsForConnection(baseConnection());
    expect(result).toEqual({ synced: false, reason: 'no_access_token' });
    expect(mockState.fetch).not.toHaveBeenCalled();
  });
});

describe('syncAnalyticsForConnection — request shape', () => {
  it('posts to runReport with the property in the URL path and the right dimensions/metrics', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ rows: [] }));
    await syncAnalyticsForConnection(baseConnection());
    const [url, init] = mockState.fetch.mock.calls[0];
    expect(url).toBe('https://analyticsdata.googleapis.com/v1beta/properties/1000:runReport');
    const body = JSON.parse(init.body);
    expect(body.dimensions).toEqual([{ name: 'date' }]);
    expect(body.metrics).toEqual([{ name: 'activeUsers' }, { name: 'sessions' }]);
    // Request date range uses YYYY-MM-DD (dashed) — different from the
    // response's date dimension format, see the module header.
    expect(body.dateRanges[0].startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.dateRanges[0].endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('syncAnalyticsForConnection — YYYYMMDD response date parsing + idempotent upsert', () => {
  it('parses the YYYYMMDD date dimension value into the correct date and upserts users/sessions', async () => {
    mockState.fetch.mockResolvedValueOnce(
      jsonResponse({
        rows: [
          { dimensionValues: [{ value: '20260901' }], metricValues: [{ value: '120' }, { value: '340' }] },
          { dimensionValues: [{ value: '20260902' }], metricValues: [{ value: '150' }, { value: '400' }] },
        ],
      }),
    );
    const result = await syncAnalyticsForConnection(baseConnection());

    expect(result).toEqual({ synced: true, dayCount: 2 });
    expect(mockState.metricUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { connectionId_date: { connectionId: 'conn_1', date: new Date('2026-09-01') } },
        create: expect.objectContaining({ users: 120, sessions: 340 }),
      }),
    );
  });

  it('a second sync run on the same day upserts (not inserts) — never a duplicate row', async () => {
    const row = { dimensionValues: [{ value: '20260901' }], metricValues: [{ value: '120' }, { value: '340' }] };
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ rows: [row] }));
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ rows: [row] }));

    await syncAnalyticsForConnection(baseConnection());
    await syncAnalyticsForConnection(baseConnection(), { force: true });

    expect(mockState.metricUpsert).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = mockState.metricUpsert.mock.calls;
    expect(firstCall[0].where).toEqual(secondCall[0].where);
  });

  it('skips a row with a malformed date dimension value rather than upserting a broken row', async () => {
    mockState.fetch.mockResolvedValueOnce(
      jsonResponse({ rows: [{ dimensionValues: [{ value: '2026-09-01' }], metricValues: [{ value: '1' }, { value: '1' }] }] }),
    );
    const result = await syncAnalyticsForConnection(baseConnection());
    expect(result.dayCount).toBe(0);
    expect(mockState.metricUpsert).not.toHaveBeenCalled();
  });
});

describe('syncAnalyticsForConnection — failure handling', () => {
  it('records lastSyncError and does not throw when the API call fails', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({}, false, 500));
    const result = await syncAnalyticsForConnection(baseConnection());
    expect(result).toEqual({ synced: false, reason: 'api_error' });
    expect(mockState.connectionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastSyncError: expect.stringContaining('500') }) }),
    );
  });

  it('clears lastSyncError on a subsequent successful sync', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ rows: [] }));
    await syncAnalyticsForConnection(baseConnection());
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
      .mockResolvedValueOnce(jsonResponse({ rows: [] })) // due_1 succeeds
      .mockResolvedValueOnce(jsonResponse({}, false, 500)); // due_2_fails fails

    const result = await syncAllDueConnections();
    expect(result).toEqual({ swept: 3, synced: 1 });
    expect(mockState.fetch).toHaveBeenCalledTimes(2);
  });
});
