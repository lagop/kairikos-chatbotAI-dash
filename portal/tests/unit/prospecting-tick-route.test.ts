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
  sweepPendingEnrichment: vi.fn(),
  runProspectingContact: vi.fn(),
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

vi.mock('@/lib/prospecting-enrichment', () => ({
  sweepPendingEnrichment: (...a: unknown[]) => mockState.sweepPendingEnrichment(...a),
}));

vi.mock('@/lib/prospecting-contact', () => ({
  runProspectingContact: (...a: unknown[]) => mockState.runProspectingContact(...a),
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
  mockState.sweepPendingEnrichment.mockReset().mockResolvedValue({ processed: 0, delivered: 0, crawlFailed: 0 });
  mockState.runProspectingContact.mockReset().mockResolvedValue({ ok: true, sent: 0, failed: 0, capReached: false });
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

  describe('Fase B — enrichment sweep', () => {
    it('runs the enrichment sweep once per tick and reports it in the response', async () => {
      mockState.sweepPendingEnrichment.mockResolvedValue({ processed: 3, delivered: 2, crawlFailed: 1 });
      const res = await get(makeRequest());
      const body = await res.json();
      expect(mockState.sweepPendingEnrichment).toHaveBeenCalledTimes(1);
      expect(body.enrichment).toEqual({ ok: true, processed: 3, delivered: 2, crawlFailed: 1 });
    });

    it('a throwing enrichment sweep does not fail the tick or the campaign results already computed', async () => {
      mockState.sweepPendingEnrichment.mockRejectedValue(new Error('sweep boom'));
      const res = await get(makeRequest());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results.camp_a.ok).toBe(true);
      expect(body.enrichment).toEqual({ ok: false, error: 'sweep boom' });
      expect(mockState.logError).toHaveBeenCalledWith('prospecting_tick.enrichment_failed', expect.anything(), {}, 'warn');
    });
  });

  describe('Fase C — auto-contact dispatch', () => {
    it('only runs contact for campaigns that have given consent, regardless of isProspectingRunDue', async () => {
      // CAMPAIGN_B is NOT due (isProspectingRunDue only allows null lastRunAt
      // by default in this file's mock) but consent must still be checked —
      // contact is lead-driven, not tied to the weekly search cadence.
      mockState.campaignFindMany.mockResolvedValue([
        { ...CAMPAIGN_A, consentAcknowledgedAt: new Date('2026-09-01') },
        { ...CAMPAIGN_B, consentAcknowledgedAt: new Date('2026-09-01') },
      ]);
      const res = await get(makeRequest());
      const body = await res.json();
      expect(mockState.runProspectingContact).toHaveBeenCalledTimes(2);
      expect(Object.keys(body.contact)).toEqual(['camp_a', 'camp_b']);
    });

    it('never calls contact for a campaign with no consent', async () => {
      mockState.campaignFindMany.mockResolvedValue([{ ...CAMPAIGN_A, consentAcknowledgedAt: null }]);
      const res = await get(makeRequest());
      const body = await res.json();
      expect(mockState.runProspectingContact).not.toHaveBeenCalled();
      expect(body.contact).toEqual({});
    });

    it('reports each campaign\'s contact outcome in the response', async () => {
      mockState.campaignFindMany.mockResolvedValue([{ ...CAMPAIGN_A, consentAcknowledgedAt: new Date('2026-09-01') }]);
      mockState.runProspectingContact.mockResolvedValue({ ok: true, sent: 2, failed: 0, capReached: false });
      const res = await get(makeRequest());
      const body = await res.json();
      expect(body.contact.camp_a).toEqual({ ok: true, sent: 2, failed: 0, capReached: false });
    });

    it('one campaign throwing during contact does not stop the tick or lose the other campaigns\' outcomes', async () => {
      mockState.campaignFindMany.mockResolvedValue([
        { ...CAMPAIGN_A, id: 'camp_a', consentAcknowledgedAt: new Date('2026-09-01') },
        { ...CAMPAIGN_B, id: 'camp_c', consentAcknowledgedAt: new Date('2026-09-01') },
      ]);
      mockState.runProspectingContact
        .mockRejectedValueOnce(new Error('contact boom'))
        .mockResolvedValueOnce({ ok: true, sent: 1, failed: 0, capReached: false });

      const res = await get(makeRequest());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.contact.camp_a).toEqual({ ok: false, error: 'contact boom' });
      expect(body.contact.camp_c).toEqual({ ok: true, sent: 1, failed: 0, capReached: false });
      expect(mockState.logError).toHaveBeenCalledWith('prospecting_tick.contact_failed', expect.anything(), { campaignId: 'camp_a' }, 'warn');
    });
  });
});
