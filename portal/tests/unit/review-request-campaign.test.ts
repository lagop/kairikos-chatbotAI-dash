// =============================================================================
// WP-22b — unit tests for src/lib/review-request-campaign.ts.
//
// Covers: the review-gating policy invariant (every recipient gets the
// identical email — no branch anywhere on a satisfaction/experience
// field, because the code has no such field to branch on), recipient
// dedup, the review-URL cache-on-first-use behavior, per-request status
// bookkeeping, and retryFailedRequests only ever touching 'failed' rows.
//
// Resend itself is loaded via a dynamic `(0, eval)('require')` (see the
// file's own header comment — deliberate, to dodge Edge/webpack bundling
// of the SDK) rather than a static import, so these tests exercise
// sendReviewRequestEmail's REAL no-RESEND_API_KEY branch (a real,
// dev-environment code path) rather than mocking the Resend client
// itself — the orchestration logic in createCampaignWithRequests /
// retryFailedRequests is what's under test here, not Resend's wire
// format.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  getValidAccessToken: vi.fn(),
  fetchLocationReviewUrl: vi.fn(),
  connectionUpdate: vi.fn(),
  campaignCreate: vi.fn(),
  requestCreate: vi.fn(),
  requestUpdate: vi.fn(),
  requestFindMany: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/google-business', () => ({
  getValidAccessToken: (...args: unknown[]) => mockState.getValidAccessToken(...args),
  fetchLocationReviewUrl: (...args: unknown[]) => mockState.fetchLocationReviewUrl(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    googleBusinessConnection: { update: (...args: unknown[]) => mockState.connectionUpdate(...args) },
    reviewRequestCampaign: { create: (...args: unknown[]) => mockState.campaignCreate(...args) },
    reviewRequest: {
      create: (...args: unknown[]) => mockState.requestCreate(...args),
      update: (...args: unknown[]) => mockState.requestUpdate(...args),
      findMany: (...args: unknown[]) => mockState.requestFindMany(...args),
    },
  },
}));

vi.mock('@/lib/observability', () => ({
  logError: (...args: unknown[]) => mockState.logError(...args),
}));

import {
  buildReviewRequestEmail,
  sendReviewRequestEmail,
  createCampaignWithRequests,
  retryFailedRequests,
  isConsentBasis,
} from '@/lib/review-request-campaign';

function baseConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn_1',
    clientId: 'client_1',
    tenantId: 'tenant_1',
    googleAccountId: 'accounts/123',
    locationId: 'locations/456',
    reviewUrl: 'https://search.google.com/local/writereview?placeid=abc',
    status: 'active',
    refreshTokenCiphertext: Buffer.from('ct'),
    refreshTokenIv: Buffer.from('iv'),
    refreshTokenTag: Buffer.from('tag'),
    ...overrides,
  } as never;
}

let requestIdCounter = 0;

beforeEach(() => {
  requestIdCounter = 0;
  mockState.getValidAccessToken.mockReset();
  mockState.fetchLocationReviewUrl.mockReset();
  mockState.connectionUpdate.mockReset().mockResolvedValue({});
  mockState.campaignCreate.mockReset().mockResolvedValue({ id: 'campaign_1' });
  mockState.requestCreate.mockReset().mockImplementation(async () => {
    requestIdCounter += 1;
    return { id: `req_${requestIdCounter}` };
  });
  mockState.requestUpdate.mockReset().mockResolvedValue({});
  mockState.requestFindMany.mockReset();
  mockState.logError.mockReset();
  delete process.env.RESEND_API_KEY;
});

afterEach(() => {
  delete process.env.RESEND_API_KEY;
});

describe('isConsentBasis', () => {
  it('accepts the two known bases and rejects anything else', () => {
    expect(isConsentBasis('customer_relationship')).toBe(true);
    expect(isConsentBasis('explicit_consent')).toBe(true);
    expect(isConsentBasis('marketing_list')).toBe(false);
  });
});

describe('buildReviewRequestEmail — review-gating policy', () => {
  it('renders the identical template shape regardless of recipient — no experience/satisfaction field exists to branch on', () => {
    const a = buildReviewRequestEmail({ recipientName: 'Ana', businessName: 'Clínica Orly', trackingUrl: 'https://portal.test/r/1' });
    const b = buildReviewRequestEmail({ recipientName: 'Carlos', businessName: 'Clínica Orly', trackingUrl: 'https://portal.test/r/2' });
    // Same subject and structure for every recipient — only the name and link vary.
    expect(a.subject).toBe(b.subject);
    expect(a.html).toContain('Dejar una reseña');
    expect(b.html).toContain('Dejar una reseña');
  });

  it('falls back to a generic greeting when no recipient name is given', () => {
    const result = buildReviewRequestEmail({ recipientName: null, businessName: 'X', trackingUrl: 'https://portal.test/r/1' });
    expect(result.text.startsWith('Hola,')).toBe(true);
  });
});

describe('sendReviewRequestEmail — guards (no Resend call)', () => {
  it('skips with no_recipient for an invalid address', async () => {
    const result = await sendReviewRequestEmail({ to: 'not-an-email', recipientName: null, businessName: 'X', trackingUrl: 'https://x' });
    expect(result).toEqual({ ok: true, skipped: true, messageId: null, reason: 'no_recipient' });
  });

  it('skips with no_api_key when RESEND_API_KEY is unset (the dev-environment default)', async () => {
    const result = await sendReviewRequestEmail({ to: 'ana@example.com', recipientName: 'Ana', businessName: 'X', trackingUrl: 'https://x' });
    expect(result).toEqual({ ok: true, skipped: true, messageId: null, reason: 'no_api_key' });
  });
});

describe('createCampaignWithRequests', () => {
  it('returns no_recipients when the recipient list is empty after dedup', async () => {
    const result = await createCampaignWithRequests({
      connection: baseConnection(),
      businessName: 'X',
      campaignName: 'Test',
      consentBasis: 'customer_relationship',
      recipients: [],
    });
    expect(result).toEqual({ ok: false, error: 'no_recipients' });
    expect(mockState.campaignCreate).not.toHaveBeenCalled();
  });

  it('dedupes recipients case-insensitively before creating requests', async () => {
    await createCampaignWithRequests({
      connection: baseConnection(),
      businessName: 'X',
      campaignName: 'Test',
      consentBasis: 'customer_relationship',
      recipients: [{ email: 'Ana@Example.com' }, { email: 'ana@example.com' }, { email: 'carlos@example.com' }],
    });
    expect(mockState.requestCreate).toHaveBeenCalledTimes(2);
  });

  it('fetches and caches the review URL on the connection when not already set', async () => {
    mockState.getValidAccessToken.mockResolvedValueOnce('at_1');
    mockState.fetchLocationReviewUrl.mockResolvedValueOnce('https://search.google.com/local/writereview?placeid=xyz');
    await createCampaignWithRequests({
      connection: baseConnection({ reviewUrl: null }),
      businessName: 'X',
      campaignName: 'Test',
      consentBasis: 'customer_relationship',
      recipients: [{ email: 'ana@example.com' }],
    });
    expect(mockState.fetchLocationReviewUrl).toHaveBeenCalledWith('at_1', 'locations/456');
    expect(mockState.connectionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { reviewUrl: 'https://search.google.com/local/writereview?placeid=xyz' } }),
    );
  });

  it('returns no_review_url and creates no campaign when the review URL cannot be resolved', async () => {
    mockState.getValidAccessToken.mockResolvedValueOnce(null);
    const result = await createCampaignWithRequests({
      connection: baseConnection({ reviewUrl: null }),
      businessName: 'X',
      campaignName: 'Test',
      consentBasis: 'customer_relationship',
      recipients: [{ email: 'ana@example.com' }],
    });
    expect(result).toEqual({ ok: false, error: 'no_review_url' });
    expect(mockState.campaignCreate).not.toHaveBeenCalled();
  });

  it('creates one ReviewRequest per recipient and records the same consentBasis for every one (uniform treatment)', async () => {
    const result = await createCampaignWithRequests({
      connection: baseConnection(),
      businessName: 'X',
      campaignName: 'Test',
      consentBasis: 'explicit_consent',
      recipients: [{ email: 'ana@example.com' }, { email: 'carlos@example.com' }],
    });
    expect(result.ok).toBe(true);
    for (const call of mockState.requestCreate.mock.calls) {
      expect(call[0].data.consentBasis).toBe('explicit_consent');
      expect(call[0].data.channel).toBe('email');
    }
  });

  it('records every request as sent (with a skipped note) when RESEND_API_KEY is unset — the dev no-op path', async () => {
    const result = await createCampaignWithRequests({
      connection: baseConnection(),
      businessName: 'X',
      campaignName: 'Test',
      consentBasis: 'customer_relationship',
      recipients: [{ email: 'ana@example.com' }],
    });
    expect(result).toEqual({ ok: true, campaignId: 'campaign_1', sent: 0, failed: 0, skipped: 1 });
    expect(mockState.requestUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'sent', sendError: 'skipped:no_api_key' }) }),
    );
  });
});

describe('retryFailedRequests', () => {
  it('only queries and touches requests currently in failed status', async () => {
    mockState.requestFindMany.mockResolvedValueOnce([
      { id: 'req_failed_1', recipient: 'ana@example.com', recipientName: 'Ana' },
    ]);
    const result = await retryFailedRequests('campaign_1', 'X');
    expect(mockState.requestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { campaignId: 'campaign_1', status: 'failed' } }),
    );
    expect(result.retried).toBe(1);
  });

  it('returns zero retried when there are no failed requests', async () => {
    mockState.requestFindMany.mockResolvedValueOnce([]);
    const result = await retryFailedRequests('campaign_1', 'X');
    expect(result).toEqual({ retried: 0, sent: 0, failed: 0 });
    expect(mockState.requestUpdate).not.toHaveBeenCalled();
  });
});
