// =============================================================================
// SEO con IA, Fase B — unit tests for src/lib/seo-search-console-sync.ts.
//
// Mirrors google-review-sync.test.ts's conventions closely. Covers: the
// coarser (24h default) min-interval guard, idempotent upsert by
// (connectionId, date), per-connection error isolation in the sweep,
// and failure handling.
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

vi.mock('@/lib/google-search-console', () => ({
  getValidAccessToken: (...args: unknown[]) => mockState.getValidAccessToken(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    seoSearchConsoleMetric: { upsert: (...args: unknown[]) => mockState.metricUpsert(...args) },
    googleSeoConnection: {
      update: (...args: unknown[]) => mockState.connectionUpdate(...args),
      findMany: (...args: unknown[]) => mockState.connectionFindMany(...args),
    },
  },
}));

vi.mock('@/lib/observability', () => ({
  logError: (...args: unknown[]) => mockState.logError(...args),
}));

import { isSyncDue, syncSearchConsoleForConnection, syncAllDueConnections } from '@/lib/seo-search-console-sync';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

function baseConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn_1',
    clientId: 'client_1',
    tenantId: 'tenant_1',
    searchConsoleSiteUrl: 'https://negocio.example/',
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
  delete process.env.SEO_SEARCH_CONSOLE_SYNC_MIN_INTERVAL_HOURS;
});

afterEach(() => {
  delete process.env.SEO_SEARCH_CONSOLE_SYNC_MIN_INTERVAL_HOURS;
});

describe('isSyncDue', () => {
  it('is due when there is no prior sync', () => {
    expect(isSyncDue(null)).toBe(true);
  });

  it('is NOT due within the default 24-hour interval', () => {
    expect(isSyncDue(new Date(Date.now() - 60 * 60_000))).toBe(false);
  });

  it('is due once the configured interval has elapsed', () => {
    process.env.SEO_SEARCH_CONSOLE_SYNC_MIN_INTERVAL_HOURS = '1';
    expect(isSyncDue(new Date(Date.now() - 2 * 60 * 60_000))).toBe(true);
  });
});

describe('syncSearchConsoleForConnection — guards', () => {
  it('skips a non-active connection without calling Google', async () => {
    const result = await syncSearchConsoleForConnection(baseConnection({ status: 'needs_reconnect' }));
    expect(result).toEqual({ synced: false, reason: 'not_active' });
    expect(mockState.getValidAccessToken).not.toHaveBeenCalled();
  });

  it('skips a too-recent sync unless forced', async () => {
    const result = await syncSearchConsoleForConnection(baseConnection({ lastSyncAt: new Date() }));
    expect(result).toEqual({ synced: false, reason: 'too_recent' });
    expect(mockState.getValidAccessToken).not.toHaveBeenCalled();
  });

  it('runs anyway when forced, even if recently synced', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ rows: [] }));
    const result = await syncSearchConsoleForConnection(baseConnection({ lastSyncAt: new Date() }), { force: true });
    expect(result.synced).toBe(true);
  });

  it('returns no_access_token when getValidAccessToken fails', async () => {
    mockState.getValidAccessToken.mockResolvedValueOnce(null);
    const result = await syncSearchConsoleForConnection(baseConnection());
    expect(result).toEqual({ synced: false, reason: 'no_access_token' });
    expect(mockState.fetch).not.toHaveBeenCalled();
  });
});

describe('syncSearchConsoleForConnection — request shape', () => {
  it('URL-encodes the site URL into the path and dimensions by date', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ rows: [] }));
    await syncSearchConsoleForConnection(baseConnection({ searchConsoleSiteUrl: 'sc-domain:negocio.example' }));
    const [url, init] = mockState.fetch.mock.calls[0];
    expect(url).toBe('https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Anegocio.example/searchAnalytics/query');
    const body = JSON.parse(init.body);
    expect(body.dimensions).toEqual(['date']);
    expect(body.aggregationType).toBe('byProperty');
  });
});

describe('syncSearchConsoleForConnection — idempotent upsert by (connectionId, date)', () => {
  it('upserts each day row keyed by connectionId + date', async () => {
    mockState.fetch.mockResolvedValueOnce(
      jsonResponse({
        rows: [
          { keys: ['2026-09-01'], clicks: 12, impressions: 340, ctr: 0.035, position: 8.2 },
          { keys: ['2026-09-02'], clicks: 15, impressions: 400, ctr: 0.0375, position: 7.9 },
        ],
      }),
    );
    const result = await syncSearchConsoleForConnection(baseConnection());

    expect(result).toEqual({ synced: true, dayCount: 2 });
    expect(mockState.metricUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { connectionId_date: { connectionId: 'conn_1', date: new Date('2026-09-01') } },
        create: expect.objectContaining({ clicks: 12, impressions: 340, ctr: 0.035, position: 8.2 }),
      }),
    );
  });

  it('a second sync run on the same day upserts (not inserts) — never a duplicate row', async () => {
    const row = { keys: ['2026-09-01'], clicks: 12, impressions: 340, ctr: 0.035, position: 8.2 };
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ rows: [row] }));
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ rows: [row] }));

    await syncSearchConsoleForConnection(baseConnection());
    await syncSearchConsoleForConnection(baseConnection(), { force: true });

    expect(mockState.metricUpsert).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = mockState.metricUpsert.mock.calls;
    expect(firstCall[0].where).toEqual(secondCall[0].where);
  });

  it('skips a row missing the date key rather than upserting a broken row', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ rows: [{ clicks: 5 }] }));
    const result = await syncSearchConsoleForConnection(baseConnection());
    expect(result.dayCount).toBe(0);
    expect(mockState.metricUpsert).not.toHaveBeenCalled();
  });
});

describe('syncSearchConsoleForConnection — failure handling', () => {
  it('records lastSyncError and does not throw when the API call fails', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({}, false, 500));
    const result = await syncSearchConsoleForConnection(baseConnection());
    expect(result).toEqual({ synced: false, reason: 'api_error' });
    expect(mockState.connectionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastSyncError: expect.stringContaining('500') }) }),
    );
  });

  it('clears lastSyncError on a subsequent successful sync', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ rows: [] }));
    await syncSearchConsoleForConnection(baseConnection());
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
