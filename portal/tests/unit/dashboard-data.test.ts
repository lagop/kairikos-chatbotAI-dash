// =============================================================================
// WP-08 / WP-17 — unit tests for getDashboardData(), the single data
// function that backs /portal (the real, nav-linked client summary
// screen — see that page's own header comment for why not
// /portal/dashboard). This is the exact regression class behind
// KAIA-11329/-11641/-11955 (a real customer seeing MOCK_CLIENT), so each
// of the three source branches gets its own test, plus the
// both-sources-failed alert path.
//
// WP-17 adds: N ClientProduct cards (not a hardcoded chatbot-only array
// of one), the whose-turn-is-it logic per onboardingState, and the
// chatbot activity trend (current vs previous 7-day window) — the real
// fix for the CONFIRMADO audit finding (fallbackRate/escalationRate were
// hardcoded to 0 here before, computed independently — and wrongly — by
// two OTHER pages).
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const findUniqueClient = vi.fn();
const findManyClientProducts = vi.fn();
const findManyConfigSteps = vi.fn();
const findManyActivities = vi.fn();
const findManyConversations = vi.fn();

vi.mock('@/lib/prisma', () => ({
  isDatabaseConfigured: true,
  prisma: {
    chatbotClient: { findUnique: (...args: unknown[]) => findUniqueClient(...args) },
    clientProduct: { findMany: (...args: unknown[]) => findManyClientProducts(...args) },
    chatbotConfigStep: { findMany: (...args: unknown[]) => findManyConfigSteps(...args) },
    chatbotActivity: { findMany: (...args: unknown[]) => findManyActivities(...args) },
    chatbotConversation: { findMany: (...args: unknown[]) => findManyConversations(...args) },
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

function chatbotClientProduct(overrides: Record<string, unknown> = {}) {
  return {
    onboardingState: 'in-progress',
    goLiveAt: null,
    product: { code: 'chatbot', name: 'Chatbot IA' },
    ...overrides,
  };
}

beforeEach(() => {
  findUniqueClient.mockReset();
  findManyClientProducts.mockReset().mockResolvedValue([]);
  findManyConfigSteps.mockReset().mockResolvedValue([]);
  findManyActivities.mockReset().mockResolvedValue([]);
  findManyConversations.mockReset().mockResolvedValue([]);
  loadClientProfileViaPortalApi.mockReset();
  logError.mockClear();
  notifyOperatorOfExecutionFailure.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getDashboardData — source: prisma', () => {
  it('real client + one active ClientProduct → one product card', async () => {
    findUniqueClient.mockResolvedValueOnce({ companyName: 'Orly Dental', name: 'Orly' });
    findManyClientProducts.mockResolvedValueOnce([
      chatbotClientProduct({ goLiveAt: new Date('2026-05-29T09:00:00.000Z'), onboardingState: 'live' }),
    ]);
    findManyActivities.mockResolvedValueOnce([
      { id: 'a1', milestone: 'T+0', notes: 'kickoff', completedAt: new Date('2026-05-22T10:00:00.000Z') },
      { id: 'a2', milestone: 'T+3', notes: null, completedAt: null },
    ]);
    findManyConversations.mockResolvedValueOnce([{ outcome: 'resolved' }, { outcome: 'fallback' }]);
    findManyConversations.mockResolvedValueOnce([{ outcome: 'resolved' }]);

    const data = await getDashboardData(RESOLVED);

    expect(data.source).toBe('prisma');
    expect(data.client).toEqual({ id: 'client_1', name: 'Orly Dental' });
    expect(data.products).toHaveLength(1);
    const chatbot = data.products[0];
    expect(chatbot.productCode).toBe('chatbot');
    expect(chatbot.onboardingState).toBe('live');
    expect(chatbot.goLiveAt).toBe('2026-05-29T09:00:00.000Z');
    expect(chatbot.turn).toBeNull();
    expect(chatbot.progressPercent).toBe(100);
    expect(chatbot.timeline).toHaveLength(2);
    expect(chatbot.timeline[0]).toMatchObject({ id: 'a1', status: 'done' });
    expect(chatbot.timeline[1]).toMatchObject({ id: 'a2', status: 'current' });
    // WP-17 — the CONFIRMADO fix: real rates from ChatbotConversation.outcome.
    expect(chatbot.activity).toEqual({
      last7Days: { conversations: 2, fallbackRate: 0.5, escalationRate: 0 },
      previous7Days: { conversations: 1, fallbackRate: 0, escalationRate: 0 },
    });
    expect(loadClientProfileViaPortalApi).not.toHaveBeenCalled();
    expect(notifyOperatorOfExecutionFailure).not.toHaveBeenCalled();
  });

  it('in-progress with a required step still in draft → turn: client, CTA links to that step', async () => {
    findUniqueClient.mockResolvedValueOnce({ companyName: 'Orly', name: 'Orly' });
    findManyClientProducts.mockResolvedValueOnce([chatbotClientProduct()]);
    findManyConfigSteps.mockResolvedValueOnce([
      { stepKey: '1', status: 'approved', activeForBot: true },
      { stepKey: '2', status: 'draft', activeForBot: false },
    ]);

    const data = await getDashboardData(RESOLVED);

    const chatbot = data.products[0];
    expect(chatbot.turn).toBe('client');
    expect(chatbot.ctaHref).toBe('/portal/wizard/chatbot/2');
    expect(chatbot.ctaLabel).toMatch(/Completa \d+ pasos?/);
  });

  it('in-progress with every required step at least submitted → turn: kairikos, no CTA link', async () => {
    findUniqueClient.mockResolvedValueOnce({ companyName: 'Orly', name: 'Orly' });
    findManyClientProducts.mockResolvedValueOnce([chatbotClientProduct()]);
    // Chatbot's required step keys: 1,2,3,4,5,6,7,9,10,11 (Step 8 and 12
    // are not requiredForReady) — all submitted, none approved yet.
    findManyConfigSteps.mockResolvedValueOnce(
      ['1', '2', '3', '4', '5', '6', '7', '9', '10', '11'].map((stepKey) => ({
        stepKey,
        status: 'submitted',
        activeForBot: false,
      })),
    );

    const data = await getDashboardData(RESOLVED);

    const chatbot = data.products[0];
    expect(chatbot.turn).toBe('kairikos');
    expect(chatbot.ctaHref).toBeNull();
    expect(chatbot.ctaLabel).toBe('En revisión de Kairikos');
    expect(chatbot.progressPercent).toBe(0);
  });

  it('ready → turn: client, CTA points at go-live self-service', async () => {
    findUniqueClient.mockResolvedValueOnce({ companyName: 'Orly', name: 'Orly' });
    findManyClientProducts.mockResolvedValueOnce([chatbotClientProduct({ onboardingState: 'ready' })]);

    const data = await getDashboardData(RESOLVED);

    const chatbot = data.products[0];
    expect(chatbot.turn).toBe('client');
    expect(chatbot.ctaHref).toBe('/portal/onboarding');
    expect(chatbot.progressPercent).toBe(100);
    expect(findManyConfigSteps).not.toHaveBeenCalled();
  });

  it('go-live-pending → turn: kairikos', async () => {
    findUniqueClient.mockResolvedValueOnce({ companyName: 'Orly', name: 'Orly' });
    findManyClientProducts.mockResolvedValueOnce([chatbotClientProduct({ onboardingState: 'go-live-pending' })]);

    const data = await getDashboardData(RESOLVED);

    expect(data.products[0].turn).toBe('kairikos');
  });

  it('updating → turn: client (a step needs rework while live)', async () => {
    findUniqueClient.mockResolvedValueOnce({ companyName: 'Orly', name: 'Orly' });
    findManyClientProducts.mockResolvedValueOnce([chatbotClientProduct({ onboardingState: 'updating' })]);

    const data = await getDashboardData(RESOLVED);

    expect(data.products[0].turn).toBe('client');
  });

  it('paused (operator override) → turn: null, informational CTA', async () => {
    findUniqueClient.mockResolvedValueOnce({ companyName: 'Orly', name: 'Orly' });
    findManyClientProducts.mockResolvedValueOnce([chatbotClientProduct({ onboardingState: 'paused' })]);

    const data = await getDashboardData(RESOLVED);

    const chatbot = data.products[0];
    expect(chatbot.turn).toBeNull();
    expect(chatbot.ctaHref).toBe('/portal/support');
  });

  it('a contracted product with an empty catalog (WP-15) shows "Próximamente", no progress query', async () => {
    findUniqueClient.mockResolvedValueOnce({ companyName: 'Orly', name: 'Orly' });
    findManyClientProducts.mockResolvedValueOnce([
      { onboardingState: 'in-progress', goLiveAt: null, product: { code: 'web', name: 'Plataforma Web' } },
    ]);

    const data = await getDashboardData(RESOLVED);

    expect(data.products).toHaveLength(1);
    const web = data.products[0];
    expect(web.productCode).toBe('web');
    expect(web.progressPercent).toBeNull();
    expect(web.turn).toBeNull();
    expect(web.ctaLabel).toBe('Próximamente');
    expect(web.activity).toBeNull();
    expect(findManyConfigSteps).not.toHaveBeenCalled();
  });

  it('live product other than chatbot → CTA links to its own portal page, not a dead end', async () => {
    findUniqueClient.mockResolvedValueOnce({ companyName: 'Orly', name: 'Orly' });
    findManyClientProducts.mockResolvedValueOnce([
      { onboardingState: 'live', goLiveAt: new Date('2026-01-01T00:00:00.000Z'), product: { code: 'web', name: 'Plataforma Web' } },
      { onboardingState: 'live', goLiveAt: new Date('2026-01-01T00:00:00.000Z'), product: { code: 'reviews', name: 'Reseñas en Google' } },
    ]);

    const data = await getDashboardData(RESOLVED);

    const [web, reviews] = data.products;
    expect(web.ctaHref).toBe('/portal/web');
    // Reviews keeps its pre-existing Spanish route folder, not /portal/reviews.
    expect(reviews.ctaHref).toBe('/portal/resenas');
  });

  it('N active ClientProducts → N cards, only chatbot carries activity metrics', async () => {
    findUniqueClient.mockResolvedValueOnce({ companyName: 'Orly', name: 'Orly' });
    findManyClientProducts.mockResolvedValueOnce([
      chatbotClientProduct({ onboardingState: 'live', goLiveAt: new Date('2026-01-01T00:00:00.000Z') }),
      { onboardingState: 'in-progress', goLiveAt: null, product: { code: 'seo', name: 'SEO con IA' } },
    ]);

    const data = await getDashboardData(RESOLVED);

    expect(data.products.map((p) => p.productCode)).toEqual(['chatbot', 'seo']);
    expect(data.products[0].activity).not.toBeNull();
    expect(data.products[1].activity).toBeNull();
  });

  it('client not found — logs an anomaly but still resolves (no products)', async () => {
    findUniqueClient.mockResolvedValueOnce(null);

    const data = await getDashboardData(RESOLVED);

    expect(data.source).toBe('mock_dev');
    expect(logError).toHaveBeenCalledWith(
      'dashboard.client_not_found',
      expect.any(Error),
      expect.objectContaining({ clientId: 'client_1' }),
      'warn',
    );
  });

  it('the products build failing degrades to an empty list, not a page-level failure', async () => {
    findUniqueClient.mockResolvedValueOnce({ companyName: 'Orly', name: 'Orly' });
    findManyClientProducts.mockRejectedValueOnce(new Error('tenant_id column missing'));

    const data = await getDashboardData(RESOLVED);

    expect(data.source).toBe('prisma');
    expect(data.products).toEqual([]);
    expect(logError).toHaveBeenCalledWith(
      'dashboard.products_build_failed',
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
    expect(data.products).toHaveLength(1);
    expect(data.products[0].goLiveAt).toBe('2026-05-29T09:00:00.000Z');
    expect(data.products[0].progressPercent).toBeNull();
    expect(notifyOperatorOfExecutionFailure).not.toHaveBeenCalled();
  });

  it('both sources fail — alerts the operator, empty products', async () => {
    findUniqueClient.mockRejectedValueOnce(new Error('connection refused'));
    loadClientProfileViaPortalApi.mockResolvedValueOnce(null);

    const data = await getDashboardData(RESOLVED);

    expect(data.source).toBe('mock_dev');
    expect(data.products).toEqual([]);
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
    loadClientProfileViaPortalApi.mockResolvedValueOnce(null);

    const data = await getDashboardData(devResolved);

    // isDatabaseConfigured is mocked true at module scope for this whole
    // file, so the `source === 'mock_dev' && !isDatabaseConfigured`
    // short-circuit does NOT fire — it falls through to a real (failing)
    // Prisma attempt, landing on source: 'mock_dev' by default since
    // nothing else succeeded either. That's the exact condition the
    // page checks to show the diagnostic banner.
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
        clientProduct: { findMany: findManyClientProducts },
        chatbotConfigStep: { findMany: findManyConfigSteps },
        chatbotActivity: { findMany: findManyActivities },
        chatbotConversation: { findMany: findManyConversations },
      },
    }));
    findUniqueClient.mockReset();

    const { getDashboardData: getDashboardDataNoDb } = await import('@/lib/dashboard-data');
    const devResolved: ResolvedClient = { clientId: 'mock-1', email: 'dev@kairikos.com', source: 'mock_dev' };
    const data = await getDashboardDataNoDb(devResolved);

    expect(data.source).toBe('mock_dev');
    expect(data.client.id).toBe(MOCK_CLIENT.id);
    expect(data.products).toHaveLength(1);
    expect(data.products[0].productCode).toBe('chatbot');
    expect(findUniqueClient).not.toHaveBeenCalled();
  });
});
