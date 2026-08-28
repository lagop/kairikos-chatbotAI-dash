// =============================================================================
// SEO con IA, Fase C — unit tests for src/lib/seo-content-generation.ts.
//
// Mirrors prospecting-enrichment.test.ts's conventions. Covers: the
// cadence guard (minIntervalDays is a plain parameter — the operator-
// configured resolution itself is seo-settings.test.ts's job), signal-
// building from the latest audit + Search Console totals, request-time
// draft row creation, delivery failure isolation, and
// lastContentRequestedAt stamping regardless of delivery outcome.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  deliverChannelEvent: vi.fn(),
  getContentGenerationMinIntervalDays: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/channel-webhook', () => ({
  deliverChannelEvent: (...args: unknown[]) => mockState.deliverChannelEvent(...args),
}));

vi.mock('@/lib/seo-settings', () => ({
  getContentGenerationMinIntervalDays: (...args: unknown[]) => mockState.getContentGenerationMinIntervalDays(...args),
}));

vi.mock('@/lib/observability', () => ({
  logError: (...args: unknown[]) => mockState.logError(...args),
}));

import { isGenerationDue, sweepDueProfiles } from '@/lib/seo-content-generation';

function baseProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'profile_1',
    clientId: 'client_1',
    tenantId: 'tenant_1',
    businessDescription: 'Ferretería de barrio con más de 20 años de historia.',
    targetAudience: 'Vecinos y pequeños talleres.',
    toneOfVoice: 'Cercano y directo.',
    siteUrl: 'https://ferreteriacentral.example',
    lastAuditResult: { title: 'Ferretería Central', h1Count: 1 },
    lastContentRequestedAt: null,
    contentGenerationMinIntervalDaysOverride: null,
    ...overrides,
  };
}

function makePrisma(profiles: ReturnType<typeof baseProfile>[]) {
  const seoProfileUpdate = vi.fn().mockResolvedValue({});
  const seoContentDraftCreate = vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: `draft_for_${data.profileId}`, ...data }),
  );
  const googleSeoConnectionFindUnique = vi.fn().mockResolvedValue(null);
  const seoSearchConsoleMetricFindMany = vi.fn().mockResolvedValue([]);

  return {
    seoProfile: {
      findMany: vi.fn().mockResolvedValue(profiles),
      update: seoProfileUpdate,
    },
    seoContentDraft: { create: seoContentDraftCreate },
    googleSeoConnection: { findUnique: googleSeoConnectionFindUnique },
    seoSearchConsoleMetric: { findMany: seoSearchConsoleMetricFindMany },
    __mocks: { seoProfileUpdate, seoContentDraftCreate, googleSeoConnectionFindUnique, seoSearchConsoleMetricFindMany },
  } as never;
}

beforeEach(() => {
  mockState.deliverChannelEvent.mockReset().mockResolvedValue({ ok: true, deliveryId: 'delivery_1', status: 'delivered' });
  mockState.getContentGenerationMinIntervalDays.mockReset().mockResolvedValue(3);
  mockState.logError.mockReset();
});

describe('isGenerationDue', () => {
  it('is due when there is no prior request', () => {
    expect(isGenerationDue(null, 3)).toBe(true);
  });

  it('is NOT due within the given interval', () => {
    expect(isGenerationDue(new Date(Date.now() - 1 * 24 * 60 * 60_000), 3)).toBe(false);
  });

  it('is due once the given interval has elapsed', () => {
    expect(isGenerationDue(new Date(Date.now() - 8 * 24 * 60 * 60_000), 7)).toBe(true);
  });
});

describe('sweepDueProfiles — cadence gating', () => {
  it('only processes profiles whose cadence is due', async () => {
    const prisma = makePrisma([
      baseProfile({ id: 'due_1', lastContentRequestedAt: null }),
      baseProfile({ id: 'not_due', lastContentRequestedAt: new Date() }),
    ]);
    const result = await sweepDueProfiles(prisma);
    expect(result).toEqual({ processed: 1, requested: 1, deliveryFailed: 0 });
    expect((prisma as never as { __mocks: { seoContentDraftCreate: ReturnType<typeof vi.fn> } }).__mocks.seoContentDraftCreate).toHaveBeenCalledTimes(1);
  });

  it('resolves the operator-configured interval via getContentGenerationMinIntervalDays', async () => {
    mockState.getContentGenerationMinIntervalDays.mockResolvedValueOnce(10);
    const prisma = makePrisma([
      baseProfile({ id: 'not_due_at_10', lastContentRequestedAt: new Date(Date.now() - 5 * 24 * 60 * 60_000) }),
    ]);
    const result = await sweepDueProfiles(prisma);
    expect(result).toEqual({ processed: 0, requested: 0, deliveryFailed: 0 });
    expect(mockState.getContentGenerationMinIntervalDays).toHaveBeenCalledTimes(1);
  });

  it("a profile's own contentGenerationMinIntervalDaysOverride wins over the global value", async () => {
    // Global says 10 days (not due at 5 days elapsed); the profile's own
    // override says 3 days (due at 5 days elapsed) — the override must win.
    mockState.getContentGenerationMinIntervalDays.mockResolvedValueOnce(10);
    const prisma = makePrisma([
      baseProfile({
        id: 'overridden',
        lastContentRequestedAt: new Date(Date.now() - 5 * 24 * 60 * 60_000),
        contentGenerationMinIntervalDaysOverride: 3,
      }),
    ]);
    const result = await sweepDueProfiles(prisma);
    expect(result).toEqual({ processed: 1, requested: 1, deliveryFailed: 0 });
  });

  it('a profile with no override (NULL) falls back to the global value, not "always due"', async () => {
    mockState.getContentGenerationMinIntervalDays.mockResolvedValueOnce(30);
    const prisma = makePrisma([
      baseProfile({
        id: 'no_override',
        lastContentRequestedAt: new Date(Date.now() - 5 * 24 * 60 * 60_000),
        contentGenerationMinIntervalDaysOverride: null,
      }),
    ]);
    const result = await sweepDueProfiles(prisma);
    expect(result).toEqual({ processed: 0, requested: 0, deliveryFailed: 0 });
  });
});

describe('sweepDueProfiles — draft creation + delivery', () => {
  it('creates a pending_generation draft row and delivers it under connectionType seo_content', async () => {
    const prisma = makePrisma([baseProfile()]);
    await sweepDueProfiles(prisma);

    const { seoContentDraftCreate } = (prisma as never as { __mocks: Record<string, ReturnType<typeof vi.fn>> }).__mocks;
    expect(seoContentDraftCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ profileId: 'profile_1', clientId: 'client_1', status: 'pending_generation' }),
      }),
    );
    expect(mockState.deliverChannelEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionType: 'seo_content',
        connectionId: 'draft_for_profile_1',
        clientId: 'client_1',
        payload: expect.objectContaining({ draftId: 'draft_for_profile_1', profileId: 'profile_1' }),
      }),
    );
  });

  it('includes the latest audit result and Search Console totals in the signals sent to n8n', async () => {
    const prisma = makePrisma([baseProfile()]);
    const { googleSeoConnectionFindUnique, seoSearchConsoleMetricFindMany } = (
      prisma as never as { __mocks: Record<string, ReturnType<typeof vi.fn>> }
    ).__mocks;
    googleSeoConnectionFindUnique.mockResolvedValueOnce({ id: 'conn_1', status: 'active' });
    seoSearchConsoleMetricFindMany.mockResolvedValueOnce([
      { clicks: 10, impressions: 200 },
      { clicks: 15, impressions: 250 },
    ]);

    await sweepDueProfiles(prisma);

    expect(mockState.deliverChannelEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          siteAudit: { title: 'Ferretería Central', h1Count: 1 },
          searchConsoleSummary: { totalClicks: 25, totalImpressions: 450, days: 2 },
        }),
      }),
    );
  });

  it('leaves searchConsoleSummary null when there is no active Search Console connection', async () => {
    const prisma = makePrisma([baseProfile()]);
    await sweepDueProfiles(prisma);
    expect(mockState.deliverChannelEvent).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ searchConsoleSummary: null }) }),
    );
  });

  it('stamps lastContentRequestedAt even when delivery to n8n fails', async () => {
    mockState.deliverChannelEvent.mockResolvedValueOnce({ ok: false, deliveryId: 'delivery_1', status: 'failed', error: 'boom' });
    const prisma = makePrisma([baseProfile()]);
    const result = await sweepDueProfiles(prisma);

    expect(result).toEqual({ processed: 1, requested: 0, deliveryFailed: 1 });
    const { seoProfileUpdate } = (prisma as never as { __mocks: Record<string, ReturnType<typeof vi.fn>> }).__mocks;
    expect(seoProfileUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'profile_1' }, data: expect.objectContaining({ lastContentRequestedAt: expect.any(Date) }) }),
    );
    expect(mockState.logError).toHaveBeenCalledWith(
      'seo_content_generation.delivery_failed',
      expect.any(Error),
      expect.anything(),
      'warn',
    );
  });
});
