// =============================================================================
// WP-22b — unit tests for the campaign API routes and the public
// click-tracking redirect:
//   POST/GET /api/portal/google-business/campaigns
//   PATCH    /api/portal/google-business/campaigns/[id]
//   POST     /api/portal/google-business/campaigns/[id]/retry-failed
//   GET      /r/[requestId]
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  resolveClientFromSession: vi.fn(),
  getSession: vi.fn(),
  isDatabaseConfigured: true,
  isProductContracted: vi.fn(),
  connectionFindFirst: vi.fn(),
  findUniqueClient: vi.fn(),
  campaignFindMany: vi.fn(),
  campaignFindUnique: vi.fn(),
  campaignUpdate: vi.fn(),
  requestFindUnique: vi.fn(),
  requestUpdate: vi.fn(),
  createCampaignWithRequests: vi.fn(),
  retryFailedRequests: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/observability', () => ({
  logError: (...args: unknown[]) => mockState.logError(...args),
}));

vi.mock('@/lib/portal-session', () => ({
  resolveClientFromSession: (...args: unknown[]) => mockState.resolveClientFromSession(...args),
}));

vi.mock('@/lib/session', () => ({
  getSession: (...args: unknown[]) => mockState.getSession(...args),
}));

vi.mock('@/lib/client-product-access', () => ({
  isProductContracted: (...args: unknown[]) => mockState.isProductContracted(...args),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    googleBusinessConnection: { findFirst: (...args: unknown[]) => mockState.connectionFindFirst(...args) },
    chatbotClient: { findUnique: (...args: unknown[]) => mockState.findUniqueClient(...args) },
    reviewRequestCampaign: {
      findMany: (...args: unknown[]) => mockState.campaignFindMany(...args),
      findUnique: (...args: unknown[]) => mockState.campaignFindUnique(...args),
      update: (...args: unknown[]) => mockState.campaignUpdate(...args),
    },
    reviewRequest: {
      findUnique: (...args: unknown[]) => mockState.requestFindUnique(...args),
      update: (...args: unknown[]) => mockState.requestUpdate(...args),
    },
  },
}));

vi.mock('@/lib/review-request-campaign', () => ({
  createCampaignWithRequests: (...args: unknown[]) => mockState.createCampaignWithRequests(...args),
  retryFailedRequests: (...args: unknown[]) => mockState.retryFailedRequests(...args),
  isConsentBasis: (value: string) => ['customer_relationship', 'explicit_consent'].includes(value),
  MAX_RECIPIENTS_PER_CAMPAIGN: 200,
}));

const RESOLVED = { clientId: 'client_1', email: 'a@b.com', source: 'database' as const };

beforeEach(() => {
  mockState.resolveClientFromSession.mockReset().mockResolvedValue(RESOLVED);
  mockState.getSession.mockReset().mockResolvedValue({ hasClientAccess: true });
  mockState.isDatabaseConfigured = true;
  mockState.isProductContracted.mockReset().mockResolvedValue(true);
  mockState.connectionFindFirst.mockReset().mockResolvedValue({ id: 'conn_1', status: 'active', locationId: 'locations/456' });
  mockState.findUniqueClient.mockReset().mockResolvedValue({ companyName: 'Clínica Orly', name: 'Orly' });
  mockState.campaignFindMany.mockReset().mockResolvedValue([]);
  mockState.campaignFindUnique.mockReset();
  mockState.campaignUpdate.mockReset().mockResolvedValue({ id: 'campaign_1', status: 'paused' });
  mockState.requestFindUnique.mockReset();
  mockState.requestUpdate.mockReset().mockResolvedValue({});
  mockState.createCampaignWithRequests.mockReset().mockResolvedValue({ ok: true, campaignId: 'campaign_1', sent: 2, failed: 0, skipped: 0 });
  mockState.retryFailedRequests.mockReset().mockResolvedValue({ retried: 1, sent: 1, failed: 0 });
  mockState.logError.mockReset();
});

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

describe('POST /api/portal/google-business/campaigns', () => {
  const VALID_BODY = { name: 'Test', consentBasis: 'customer_relationship', recipients: [{ email: 'ana@example.com' }] };

  it('401s when there is no session', async () => {
    mockState.resolveClientFromSession.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/portal/google-business/campaigns/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(401);
  });

  it('403s when the reviews product is not contracted', async () => {
    mockState.isProductContracted.mockResolvedValueOnce(false);
    const { POST } = await import('@/app/api/portal/google-business/campaigns/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(403);
    expect(mockState.createCampaignWithRequests).not.toHaveBeenCalled();
  });

  it('400s on an invalid consentBasis', async () => {
    const { POST } = await import('@/app/api/portal/google-business/campaigns/route');
    const res = await POST(makeRequest({ ...VALID_BODY, consentBasis: 'not_a_real_basis' }));
    expect(res.status).toBe(400);
  });

  it('404s when the client has no active connection', async () => {
    mockState.connectionFindFirst.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/portal/google-business/campaigns/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(404);
  });

  it('creates the campaign and returns the send summary on success', async () => {
    const { POST } = await import('@/app/api/portal/google-business/campaigns/route');
    const res = await POST(makeRequest(VALID_BODY));
    const body = await res.clone().json();
    expect(res.status).toBe(201);
    expect(body).toEqual({ ok: true, campaignId: 'campaign_1', sent: 2, failed: 0, skipped: 0 });
    expect(mockState.createCampaignWithRequests).toHaveBeenCalledWith(
      expect.objectContaining({ businessName: 'Clínica Orly', consentBasis: 'customer_relationship' }),
    );
  });

  it('503s when the lib reports no_review_url', async () => {
    mockState.createCampaignWithRequests.mockResolvedValueOnce({ ok: false, error: 'no_review_url' });
    const { POST } = await import('@/app/api/portal/google-business/campaigns/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(503);
  });
});

describe('PATCH /api/portal/google-business/campaigns/[id]', () => {
  it('404s when the campaign belongs to a different client', async () => {
    mockState.campaignFindUnique.mockResolvedValueOnce({ id: 'campaign_1', clientId: 'someone_else' });
    const { PATCH } = await import('@/app/api/portal/google-business/campaigns/[id]/route');
    const res = await PATCH(makeRequest({ status: 'paused' }), { params: { id: 'campaign_1' } });
    expect(res.status).toBe(404);
    expect(mockState.campaignUpdate).not.toHaveBeenCalled();
  });

  it('updates status for an owned campaign', async () => {
    mockState.campaignFindUnique.mockResolvedValueOnce({ id: 'campaign_1', clientId: 'client_1' });
    const { PATCH } = await import('@/app/api/portal/google-business/campaigns/[id]/route');
    const res = await PATCH(makeRequest({ status: 'paused' }), { params: { id: 'campaign_1' } });
    expect(res.status).toBe(200);
    expect(mockState.campaignUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'campaign_1' }, data: { status: 'paused' } }),
    );
  });
});

describe('POST /api/portal/google-business/campaigns/[id]/retry-failed', () => {
  it('404s for a campaign owned by a different client', async () => {
    mockState.campaignFindUnique.mockResolvedValueOnce({ id: 'campaign_1', clientId: 'someone_else' });
    const { POST } = await import('@/app/api/portal/google-business/campaigns/[id]/retry-failed/route');
    const res = await POST(makeRequest({}), { params: { id: 'campaign_1' } });
    expect(res.status).toBe(404);
    expect(mockState.retryFailedRequests).not.toHaveBeenCalled();
  });

  it('retries failed requests for an owned campaign', async () => {
    mockState.campaignFindUnique.mockResolvedValueOnce({ id: 'campaign_1', clientId: 'client_1' });
    const { POST } = await import('@/app/api/portal/google-business/campaigns/[id]/retry-failed/route');
    const res = await POST(makeRequest({}), { params: { id: 'campaign_1' } });
    const body = await res.clone().json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ retried: 1, sent: 1, failed: 0 });
  });
});

describe('GET /r/[requestId] — public click-tracking redirect', () => {
  it('redirects to a fallback when the request id does not exist', async () => {
    mockState.requestFindUnique.mockResolvedValueOnce(null);
    const { GET } = await import('@/app/r/[requestId]/route');
    const res = await GET({} as NextRequest, { params: { requestId: 'missing' } });
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get('location')).toContain('google.com');
  });

  it('redirects to a fallback when the connection has no reviewUrl cached', async () => {
    mockState.requestFindUnique.mockResolvedValueOnce({
      id: 'req_1',
      clickedAt: null,
      campaign: { connection: { reviewUrl: null } },
    });
    const { GET } = await import('@/app/r/[requestId]/route');
    const res = await GET({} as NextRequest, { params: { requestId: 'req_1' } });
    expect(res.headers.get('location')).toContain('google.com');
    expect(mockState.requestUpdate).not.toHaveBeenCalled();
  });

  it('falls back gracefully (not a 500) when the Prisma lookup throws — e.g. a transient DB outage', async () => {
    mockState.requestFindUnique.mockRejectedValueOnce(new Error('Cannot reach database server'));
    const { GET } = await import('@/app/r/[requestId]/route');
    const res = await GET({} as NextRequest, { params: { requestId: 'req_1' } });
    expect(res.headers.get('location')).toContain('google.com');
    expect(mockState.logError).toHaveBeenCalled();
  });

  it('records the first click and redirects to the real review URL', async () => {
    mockState.requestFindUnique.mockResolvedValueOnce({
      id: 'req_1',
      clickedAt: null,
      campaign: { connection: { reviewUrl: 'https://search.google.com/local/writereview?placeid=abc' } },
    });
    const { GET } = await import('@/app/r/[requestId]/route');
    const res = await GET({} as NextRequest, { params: { requestId: 'req_1' } });
    expect(res.headers.get('location')).toBe('https://search.google.com/local/writereview?placeid=abc');
    expect(mockState.requestUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'req_1' }, data: expect.objectContaining({ clickedAt: expect.any(Date) }) }),
    );
  });

  it('does not overwrite clickedAt on a second visit', async () => {
    const firstClick = new Date('2026-08-01T10:00:00Z');
    mockState.requestFindUnique.mockResolvedValueOnce({
      id: 'req_1',
      clickedAt: firstClick,
      campaign: { connection: { reviewUrl: 'https://search.google.com/local/writereview?placeid=abc' } },
    });
    const { GET } = await import('@/app/r/[requestId]/route');
    await GET({} as NextRequest, { params: { requestId: 'req_1' } });
    expect(mockState.requestUpdate).not.toHaveBeenCalled();
  });
});
