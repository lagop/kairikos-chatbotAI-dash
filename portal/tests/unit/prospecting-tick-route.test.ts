// =============================================================================
// Prospección con IA, Fase A — unit tests for GET /api/cron/prospecting-tick.
//
// The HTTP-layer properties that matter beyond auth: only DUE campaigns
// run (isProspectingRunDue filters them), each campaign is ISOLATED (one
// throwing must not cost the others their turn), and the batch email
// only fires when a run actually created a new lead.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  campaignFindMany: vi.fn(),
  chatbotClientFindUnique: vi.fn(),
  runProspectingSearch: vi.fn(),
  isProspectingRunDue: vi.fn(),
  sendProspectingBatchEmail: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    prospectingCampaign: { findMany: (...a: unknown[]) => mockState.campaignFindMany(...a) },
    chatbotClient: { findUnique: (...a: unknown[]) => mockState.chatbotClientFindUnique(...a) },
  },
}));

vi.mock('@/lib/prospecting', () => ({
  runProspectingSearch: (...a: unknown[]) => mockState.runProspectingSearch(...a),
  isProspectingRunDue: (...a: unknown[]) => mockState.isProspectingRunDue(...a),
}));

vi.mock('@/lib/leads-email', () => ({
  sendProspectingBatchEmail: (...a: unknown[]) => mockState.sendProspectingBatchEmail(...a),
}));

vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

const SECRET = 'cron_secret_value';

function makeRequest(auth: string | null = `Bearer ${SECRET}`) {
  return { headers: new Headers(auth ? { authorization: auth } : {}) } as unknown as NextRequest;
}

async function get(req: NextRequest) {
  const { GET } = await import('@/app/api/cron/prospecting-tick/route');
  return GET(req);
}

const CAMPAIGN_A = { id: 'camp_a', clientId: 'client_a', tenantId: null, category: 'ferretería', locationQuery: 'Las Palmas', leadsFoundThisMonth: 0, monthlyLeadCap: 100, usageResetAt: new Date(), alertedAt: null, lastRunAt: null };
const CAMPAIGN_B = { id: 'camp_b', clientId: 'client_b', tenantId: null, category: 'panadería', locationQuery: 'Tenerife', leadsFoundThisMonth: 0, monthlyLeadCap: 100, usageResetAt: new Date(), alertedAt: null, lastRunAt: new Date() };

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  mockState.isDatabaseConfigured = true;
  mockState.campaignFindMany.mockReset().mockResolvedValue([CAMPAIGN_A, CAMPAIGN_B]);
  mockState.chatbotClientFindUnique.mockReset().mockResolvedValue({ email: 'a@b.com', name: 'Owner', companyName: 'Ferretería Central' });
  mockState.runProspectingSearch.mockReset().mockResolvedValue({ ok: true, created: 2, skippedDuplicate: 0, skippedClosed: 0, detailsCallsMade: 2, capReached: false });
  mockState.isProspectingRunDue.mockReset().mockImplementation((lastRunAt: Date | null) => lastRunAt === null);
  mockState.sendProspectingBatchEmail.mockReset().mockResolvedValue({ ok: true, messageId: 'm1' });
  mockState.logError.mockReset();
});

afterAll(() => {
  delete process.env.CRON_SECRET;
});

describe('GET /api/cron/prospecting-tick', () => {
  it('401s without a matching bearer secret', async () => {
    const res = await get(makeRequest('Bearer wrong'));
    expect(res.status).toBe(401);
    expect(mockState.campaignFindMany).not.toHaveBeenCalled();
  });

  it('401s when CRON_SECRET is unset — fails closed', async () => {
    delete process.env.CRON_SECRET;
    const res = await get(makeRequest());
    expect(res.status).toBe(401);
  });

  it('only queries active campaigns with a filled-in profile', async () => {
    await get(makeRequest());
    expect(mockState.campaignFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'active', category: { not: null }, locationQuery: { not: null } },
      }),
    );
  });

  it('only runs campaigns isProspectingRunDue says are due', async () => {
    const res = await get(makeRequest());
    const body = await res.json();
    expect(body.dueCount).toBe(1);
    expect(mockState.runProspectingSearch).toHaveBeenCalledTimes(1);
    expect(mockState.runProspectingSearch).toHaveBeenCalledWith(expect.anything(), CAMPAIGN_A, expect.any(Date));
  });

  it('one campaign throwing does not stop the others from running', async () => {
    mockState.campaignFindMany.mockResolvedValue([CAMPAIGN_A, { ...CAMPAIGN_B, id: 'camp_c', lastRunAt: null }]);
    mockState.isProspectingRunDue.mockReturnValue(true);
    mockState.runProspectingSearch
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ ok: true, created: 1, skippedDuplicate: 0, skippedClosed: 0, detailsCallsMade: 1, capReached: false });

    const res = await get(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.results.camp_a.ok).toBe(false);
    expect(body.results.camp_c.ok).toBe(true);
    expect(mockState.logError).toHaveBeenCalled();
  });

  it('sends the batch email when a run creates at least one lead', async () => {
    await get(makeRequest());
    expect(mockState.sendProspectingBatchEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'a@b.com', businessName: 'Ferretería Central', count: 2 }),
    );
  });

  it('does NOT send an email when the run created nothing', async () => {
    mockState.runProspectingSearch.mockResolvedValue({ ok: true, created: 0, skippedDuplicate: 0, skippedClosed: 0, detailsCallsMade: 0, capReached: false });
    await get(makeRequest());
    expect(mockState.sendProspectingBatchEmail).not.toHaveBeenCalled();
  });

  it('a failed batch email never fails the tick — the leads already persisted', async () => {
    mockState.sendProspectingBatchEmail.mockResolvedValue({ ok: false, error: 'boom' });
    const res = await get(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.camp_a.ok).toBe(true);
  });

  it('service_unavailable when the database is not configured', async () => {
    mockState.isDatabaseConfigured = false;
    const res = await get(makeRequest());
    expect(res.status).toBe(503);
  });
});
