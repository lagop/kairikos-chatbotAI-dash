// =============================================================================
// Prospección con IA, Fase A — unit tests for src/lib/prospecting.ts
// (runProspectingSearch): the dedup, monthly-cap, and cost-invariant
// logic. google-places.ts is mocked — this file is about prospecting.ts's
// OWN decisions, which src/lib/google-places.test.ts already covers.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const mockState = vi.hoisted(() => ({
  isGooglePlacesConfigured: vi.fn(),
  searchPlaces: vi.fn(),
  getPlaceDetails: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/google-places', () => ({
  isGooglePlacesConfigured: () => mockState.isGooglePlacesConfigured(),
  searchPlaces: (...a: unknown[]) => mockState.searchPlaces(...a),
  getPlaceDetails: (...a: unknown[]) => mockState.getPlaceDetails(...a),
}));

vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

import { runProspectingSearch, type ProspectingCampaignInput } from '@/lib/prospecting';

const state = {
  leadFindMany: vi.fn(),
  leadCreate: vi.fn(),
  leadAuditCreate: vi.fn(),
  campaignUpdate: vi.fn(),
};

const mockTx = {
  lead: { create: (...a: unknown[]) => state.leadCreate(...a) },
  leadAudit: { create: (...a: unknown[]) => state.leadAuditCreate(...a) },
};

const prisma = {
  $transaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
  lead: { findMany: (...a: unknown[]) => state.leadFindMany(...a) },
  prospectingCampaign: { update: (...a: unknown[]) => state.campaignUpdate(...a) },
} as unknown as PrismaClient;

const NOW = new Date('2026-09-15T10:00:00.000Z');

function campaign(over: Partial<ProspectingCampaignInput> = {}): ProspectingCampaignInput {
  return {
    id: 'campaign_1',
    clientId: 'client_1',
    tenantId: 't1',
    category: 'ferretería',
    locationQuery: 'Las Palmas de Gran Canaria',
    leadsFoundThisMonth: 0,
    monthlyLeadCap: 100,
    usageResetAt: new Date('2026-09-01T00:00:00.000Z'),
    alertedAt: null,
    ...over,
  };
}

function place(id: string, name = id) {
  return { id, name, formattedAddress: `Dirección de ${name}`, websiteUri: null, types: [] };
}

function details(id: string, overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    data: {
      id,
      name: `Negocio ${id}`,
      formattedAddress: `Dirección de ${id}`,
      websiteUri: null,
      phoneNumber: '+34922000000',
      primaryType: 'store',
      businessStatus: 'OPERATIONAL',
      ...overrides,
    },
  };
}

beforeEach(() => {
  for (const fn of Object.values(mockState)) fn.mockReset();
  for (const fn of Object.values(state)) fn.mockReset();
  mockState.isGooglePlacesConfigured.mockReturnValue(true);
  state.leadFindMany.mockResolvedValue([]);
  state.leadCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'lead_new', ...data }),
  );
  state.campaignUpdate.mockResolvedValue({});
});

describe('runProspectingSearch — gates before ever calling Places', () => {
  it('not_configured when GOOGLE_PLACES_API_KEY is unset', async () => {
    mockState.isGooglePlacesConfigured.mockReturnValue(false);
    const result = await runProspectingSearch(prisma, campaign(), NOW);
    expect(result).toEqual({ ok: false, error: 'not_configured' });
    expect(mockState.searchPlaces).not.toHaveBeenCalled();
  });

  it('campaign_not_ready when the client has not filled in category/locationQuery yet', async () => {
    const result = await runProspectingSearch(prisma, campaign({ category: null }), NOW);
    expect(result).toEqual({ ok: false, error: 'campaign_not_ready' });
    expect(mockState.searchPlaces).not.toHaveBeenCalled();
  });
});

describe('runProspectingSearch — monthly cap', () => {
  it('stops before searching once the cap is already reached, and alerts once', async () => {
    const result = await runProspectingSearch(
      prisma,
      campaign({ leadsFoundThisMonth: 100, monthlyLeadCap: 100, alertedAt: null }),
      NOW,
    );
    expect(result).toEqual({ ok: true, created: 0, skippedDuplicate: 0, skippedClosed: 0, detailsCallsMade: 0, capReached: true });
    expect(mockState.searchPlaces).not.toHaveBeenCalled();
    expect(state.campaignUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ alertedAt: NOW }) }),
    );
  });

  it('does not re-alert on a second run past the cap — alertedAt already set', async () => {
    const alreadyAlerted = new Date('2026-09-10T00:00:00.000Z');
    await runProspectingSearch(
      prisma,
      campaign({ leadsFoundThisMonth: 100, monthlyLeadCap: 100, alertedAt: alreadyAlerted }),
      NOW,
    );
    expect(state.campaignUpdate).not.toHaveBeenCalled();
  });

  it('resets the counter on a new calendar month, ignoring the old cap breach', async () => {
    mockState.searchPlaces.mockResolvedValue({ ok: true, data: { results: [], nextPageToken: null } });
    const result = await runProspectingSearch(
      prisma,
      campaign({
        leadsFoundThisMonth: 100,
        monthlyLeadCap: 100,
        usageResetAt: new Date('2026-08-01T00:00:00.000Z'), // last month
        alertedAt: new Date('2026-08-20T00:00:00.000Z'),
      }),
      NOW, // September
    );
    expect(result.ok).toBe(true);
    expect(mockState.searchPlaces).toHaveBeenCalled(); // did NOT short-circuit on the stale cap
  });

  it('never spends more Details calls than the remaining monthly budget, even with more new results available', async () => {
    mockState.searchPlaces.mockResolvedValue({
      ok: true,
      data: { results: [place('p1'), place('p2'), place('p3')], nextPageToken: null },
    });
    mockState.getPlaceDetails.mockImplementation((id: string) => Promise.resolve(details(id)));

    const result = await runProspectingSearch(
      prisma,
      campaign({ leadsFoundThisMonth: 98, monthlyLeadCap: 100 }), // only 2 remaining
      NOW,
    );
    expect(mockState.getPlaceDetails).toHaveBeenCalledTimes(2);
    if (result.ok) {
      expect(result.created).toBe(2);
      expect(result.capReached).toBe(true);
    }
  });
});

describe('runProspectingSearch — dedup', () => {
  it('never spends a Details call on a place already found for this client', async () => {
    mockState.searchPlaces.mockResolvedValue({
      ok: true,
      data: { results: [place('p1'), place('p2')], nextPageToken: null },
    });
    state.leadFindMany.mockResolvedValue([{ externalPlaceId: 'p1' }]);
    mockState.getPlaceDetails.mockImplementation((id: string) => Promise.resolve(details(id)));

    const result = await runProspectingSearch(prisma, campaign(), NOW);

    expect(mockState.getPlaceDetails).toHaveBeenCalledTimes(1);
    expect(mockState.getPlaceDetails).toHaveBeenCalledWith('p2');
    if (result.ok) {
      expect(result.skippedDuplicate).toBe(0); // p1 filtered before "skipped due to cap", not counted there
      expect(result.created).toBe(1);
    }
  });

  it('scopes the dedup check to this client — findMany is called with clientId', async () => {
    mockState.searchPlaces.mockResolvedValue({ ok: true, data: { results: [place('p1')], nextPageToken: null } });
    mockState.getPlaceDetails.mockResolvedValue(details('p1'));
    await runProspectingSearch(prisma, campaign({ clientId: 'client_9' }), NOW);
    expect(state.leadFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ clientId: 'client_9' }) }),
    );
  });
});

describe('runProspectingSearch — billing invariant', () => {
  it('counts a Details call against leadsFoundThisMonth even for a permanently-closed business — it was still billed', async () => {
    mockState.searchPlaces.mockResolvedValue({ ok: true, data: { results: [place('p1')], nextPageToken: null } });
    mockState.getPlaceDetails.mockResolvedValue(details('p1', { businessStatus: 'CLOSED_PERMANENTLY' }));

    const result = await runProspectingSearch(prisma, campaign(), NOW);

    expect(state.leadCreate).not.toHaveBeenCalled();
    if (result.ok) {
      expect(result.detailsCallsMade).toBe(1);
      expect(result.skippedClosed).toBe(1);
      expect(result.created).toBe(0);
    }
    expect(state.campaignUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ leadsFoundThisMonth: 1 }) }),
    );
  });

  it('does NOT count a failed Details call — never billed, never a lead', async () => {
    mockState.searchPlaces.mockResolvedValue({ ok: true, data: { results: [place('p1')], nextPageToken: null } });
    mockState.getPlaceDetails.mockResolvedValue({ ok: false, error: 'quota_exceeded' });

    const result = await runProspectingSearch(prisma, campaign(), NOW);

    if (result.ok) {
      expect(result.detailsCallsMade).toBe(0);
      expect(result.created).toBe(0);
    }
    expect(state.campaignUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ leadsFoundThisMonth: 0 }) }),
    );
  });
});

describe('runProspectingSearch — Lead creation', () => {
  it('creates a Lead with source outbound, channel places, and a LeadAudit', async () => {
    mockState.searchPlaces.mockResolvedValue({ ok: true, data: { results: [place('p1')], nextPageToken: null } });
    mockState.getPlaceDetails.mockResolvedValue(details('p1'));

    await runProspectingSearch(prisma, campaign({ tenantId: 'tenant_9' }), NOW);

    expect(state.leadCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          clientId: 'client_1',
          tenantId: 'tenant_9',
          source: 'outbound',
          channel: 'places',
          status: 'nuevo',
          externalPlaceId: 'p1',
          contactPhone: '+34922000000',
        }),
      }),
    );
    expect(state.leadAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'created', statusAfter: 'nuevo', actorId: 'system:prospecting' }),
      }),
    );
  });

  it('search failure returns search_failed and touches nothing else', async () => {
    mockState.searchPlaces.mockResolvedValue({ ok: false, error: 'API key not valid' });
    const result = await runProspectingSearch(prisma, campaign(), NOW);
    expect(result).toEqual({ ok: false, error: 'search_failed' });
    expect(state.campaignUpdate).not.toHaveBeenCalled();
  });
});
