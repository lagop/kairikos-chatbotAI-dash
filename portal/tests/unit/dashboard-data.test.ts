// =============================================================================
// WP-08 — unit tests for getDashboardData(), the single data function that
// replaced the three data-source decisions previously scattered across
// /portal/dashboard's page component. This is the exact regression class
// behind KAIA-11329/-11641/-11955 (a real customer seeing MOCK_CLIENT), so
// each of the three source branches gets its own test, plus the
// both-sources-failed alert path.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const findUniqueClient = vi.fn();
const countConversations = vi.fn();
const findManyActivities = vi.fn();

vi.mock('@/lib/prisma', () => ({
  isDatabaseConfigured: true,
  prisma: {
    chatbotClient: { findUnique: (...args: unknown[]) => findUniqueClient(...args) },
    chatbotConversation: { count: (...args: unknown[]) => countConversations(...args) },
    chatbotActivity: { findMany: (...args: unknown[]) => findManyActivities(...args) },
  },
}));

const loadClientProfileViaPortalApi = vi.fn();
vi.mock('@/lib/dashboard-fallback', () => ({
  loadClientProfileViaPortalApi: (...args: unknown[]) => loadClientProfileViaPortalApi(...args),
}));

const logError = vi.fn();
vi.mock('@/lib/observability', () => ({
  logError: (...args: unknown[]) => logError(...args),
}));

const notifyOperatorOfExecutionFailure = vi.fn().mockResolvedValue({ ok: true, skipped: true, messageId: null, reason: 'no_recipients' });
vi.mock('@/lib/operator-notify', () => ({
  notifyOperatorOfExecutionFailure: (...args: unknown[]) => notifyOperatorOfExecutionFailure(...args),
}));

import { getDashboardData } from '@/lib/dashboard-data';
import { MOCK_CLIENT } from '@/lib/portal-data';
import type { ResolvedClient } from '@/lib/portal-session';

const RESOLVED: ResolvedClient = { clientId: 'client_1', email: 'a@b.com', source: 'database' };

describe('getDashboardData', () => {
  beforeEach(() => {
    findUniqueClient.mockReset();
    countConversations.mockReset();
    findManyActivities.mockReset();
    loadClientProfileViaPortalApi.mockReset();
    logError.mockClear();
    notifyOperatorOfExecutionFailure.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('source: prisma — real client + activities map onto the timeline', async () => {
    findUniqueClient.mockResolvedValueOnce({
      companyName: 'Orly Dental',
      name: 'Orly',
      goLiveAt: new Date('2026-05-29T09:00:00.000Z'),
    });
    countConversations.mockResolvedValueOnce(7);
    findManyActivities.mockResolvedValueOnce([
      { id: 'a1', milestone: 'T+0', notes: 'kickoff', completedAt: new Date('2026-05-22T10:00:00.000Z') },
      { id: 'a2', milestone: 'T+3', notes: null, completedAt: null },
    ]);

    const data = await getDashboardData(RESOLVED);

    expect(data.source).toBe('prisma');
    expect(data.client).toEqual({ id: 'client_1', name: 'Orly Dental', goLiveAt: '2026-05-29T09:00:00.000Z' });
    expect(data.timeline).toHaveLength(2);
    expect(data.timeline[0]).toMatchObject({ id: 'a1', status: 'done' });
    expect(data.timeline[1]).toMatchObject({ id: 'a2', status: 'current' });
    const chatbot = data.products.find((p) => p.product === 'chatbot');
    expect(chatbot?.summary.status).toBe('live');
    expect(chatbot?.summary.last7Days.conversations).toBe(7);
    expect(loadClientProfileViaPortalApi).not.toHaveBeenCalled();
    expect(notifyOperatorOfExecutionFailure).not.toHaveBeenCalled();
  });

  it('source: prisma, not yet live — status derives from goLiveAt being null', async () => {
    findUniqueClient.mockResolvedValueOnce({ companyName: 'Orly Dental', name: 'Orly', goLiveAt: null });
    countConversations.mockResolvedValueOnce(0);
    findManyActivities.mockResolvedValueOnce([]);

    const data = await getDashboardData(RESOLVED);

    expect(data.client.goLiveAt).toBeNull();
    const chatbot = data.products.find((p) => p.product === 'chatbot');
    expect(chatbot?.summary.status).toBe('in-progress');
    expect(data.timeline).toEqual([]);
  });

  it('activities query throwing degrades to an empty timeline, not a page-level failure', async () => {
    findUniqueClient.mockResolvedValueOnce({ companyName: 'Orly', name: 'Orly', goLiveAt: null });
    countConversations.mockResolvedValueOnce(0);
    findManyActivities.mockRejectedValueOnce(new Error('tenant_id column missing'));

    const data = await getDashboardData(RESOLVED);

    expect(data.source).toBe('prisma');
    expect(data.timeline).toEqual([]);
    expect(logError).toHaveBeenCalledWith(
      'dashboard.activities_find_many',
      expect.any(Error),
      expect.objectContaining({ clientId: 'client_1' }),
      'warn',
    );
  });

  it('source: portal_api_fallback — Prisma throws, /api/portal/me succeeds', async () => {
    findUniqueClient.mockRejectedValueOnce(new Error('Can\'t reach database server'));
    loadClientProfileViaPortalApi.mockResolvedValueOnce({
      companyName: 'Orly Dental',
      contactName: null,
      goLiveDate: '2026-05-29T09:00:00.000Z',
    });

    const data = await getDashboardData(RESOLVED);

    expect(data.source).toBe('portal_api_fallback');
    expect(data.client.name).toBe('Orly Dental');
    expect(data.client.goLiveAt).toBe('2026-05-29T09:00:00.000Z');
    expect(notifyOperatorOfExecutionFailure).not.toHaveBeenCalled();
  });

  it('both sources fail — alerts the operator and reports source unchanged from the mock default', async () => {
    findUniqueClient.mockRejectedValueOnce(new Error('connection refused'));
    loadClientProfileViaPortalApi.mockResolvedValueOnce(null);

    const data = await getDashboardData(RESOLVED);

    expect(data.source).toBe('mock_dev');
    expect(logError).toHaveBeenCalledWith(
      'dashboard.both_sources_failed',
      expect.any(Error),
      expect.objectContaining({ clientId: 'client_1', clientEmail: 'a@b.com' }),
    );
    expect(notifyOperatorOfExecutionFailure).toHaveBeenCalledTimes(1);
    const alertArg = notifyOperatorOfExecutionFailure.mock.calls[0][0];
    expect(alertArg).toMatchObject({ clientId: 'client_1', clientName: 'a@b.com' });
  });

  it('mock_dev source with a DB configured still attempts a real Prisma read (the half-configured-environment case the diagnostic banner exists for)', async () => {
    const devResolved: ResolvedClient = { clientId: 'mock-1', email: 'dev@kairikos.com', source: 'mock_dev' };
    findUniqueClient.mockResolvedValueOnce(null);
    countConversations.mockResolvedValueOnce(0);
    findManyActivities.mockResolvedValueOnce([]);
    loadClientProfileViaPortalApi.mockResolvedValueOnce(null);

    const data = await getDashboardData(devResolved);

    // isDatabaseConfigured is mocked true at module scope for this whole
    // file, so the `source === 'mock_dev' && !isDatabaseConfigured`
    // short-circuit does NOT fire — it falls through to a real (failing)
    // Prisma attempt, landing on source: 'mock_dev' by default since
    // nothing else succeeded either. That's the exact condition
    // dashboard/page.tsx checks to show the diagnostic banner.
    expect(findUniqueClient).toHaveBeenCalledTimes(1);
    expect(data.source).toBe('mock_dev');
  });
});

describe('getDashboardData — genuine dev-mock (no DB at all)', () => {
  afterEach(() => {
    vi.doUnmock('@/lib/prisma');
    vi.resetModules();
  });

  it('short-circuits straight to the fixture with zero Prisma calls', async () => {
    vi.resetModules();
    vi.doMock('@/lib/prisma', () => ({
      isDatabaseConfigured: false,
      prisma: {
        chatbotClient: { findUnique: findUniqueClient },
        chatbotConversation: { count: countConversations },
        chatbotActivity: { findMany: findManyActivities },
      },
    }));
    findUniqueClient.mockReset();

    const { getDashboardData: getDashboardDataNoDb } = await import('@/lib/dashboard-data');
    const devResolved: ResolvedClient = { clientId: 'mock-1', email: 'dev@kairikos.com', source: 'mock_dev' };
    const data = await getDashboardDataNoDb(devResolved);

    expect(data.source).toBe('mock_dev');
    expect(data.client.id).toBe(MOCK_CLIENT.id);
    expect(findUniqueClient).not.toHaveBeenCalled();
  });
});
