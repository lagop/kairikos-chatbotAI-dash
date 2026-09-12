// =============================================================================
// SEO con IA, Fase 6 — unit tests for lib/seo-draft-auto-publish.ts.
// publishAfterClientReview (lib/seo-content-review.ts) is mocked here —
// it already has full coverage via seo-portal-content-drafts-route.test.ts,
// which exercises the real implementation. This file focuses on WHICH
// drafts the sweep picks and how it isolates failures — same shape as
// seo-draft-auto-approve.test.ts's coverage of the sibling sweep.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  draftFindMany: vi.fn(),
  publishAfterClientReview: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/seo-content-review', () => ({
  publishAfterClientReview: (...a: unknown[]) => mockState.publishAfterClientReview(...a),
  AUTO_PUBLISH_REVIEWED_BY: 'system:auto_publish_client_timeout',
}));

vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

const prismaMock = { seoContentDraft: { findMany: (...a: unknown[]) => mockState.draftFindMany(...a) } } as never;

const NOW = new Date('2026-09-10T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.clearAllMocks();
  mockState.draftFindMany.mockResolvedValue([]);
  mockState.publishAfterClientReview.mockResolvedValue({ status: 'published' });
});

async function sweep(now = NOW) {
  const { sweepAutoPublishableSeoDrafts } = await import('@/lib/seo-draft-auto-publish');
  return sweepAutoPublishableSeoDrafts(prismaMock, { now });
}

describe('isDraftPastClientReviewWindow / computeAutoPublishDeadline', () => {
  it('is never due without a clientReviewRequestedAt', async () => {
    const { isDraftPastClientReviewWindow } = await import('@/lib/seo-draft-auto-publish');
    expect(isDraftPastClientReviewWindow(null, NOW)).toBe(false);
  });

  it('is due once the window elapses, not before', async () => {
    const { isDraftPastClientReviewWindow, SEO_DRAFT_CLIENT_REVIEW_WINDOW_DAYS } = await import('@/lib/seo-draft-auto-publish');
    const justInside = new Date(NOW.getTime() - (SEO_DRAFT_CLIENT_REVIEW_WINDOW_DAYS - 1) * DAY_MS);
    const justPast = new Date(NOW.getTime() - (SEO_DRAFT_CLIENT_REVIEW_WINDOW_DAYS + 1) * DAY_MS);
    expect(isDraftPastClientReviewWindow(justInside, NOW)).toBe(false);
    expect(isDraftPastClientReviewWindow(justPast, NOW)).toBe(true);
  });

  it('computeAutoPublishDeadline is null unless the draft is still pending_client_review', async () => {
    const { computeAutoPublishDeadline } = await import('@/lib/seo-draft-auto-publish');
    expect(computeAutoPublishDeadline({ status: 'published', clientReviewRequestedAt: NOW })).toBeNull();
    expect(computeAutoPublishDeadline({ status: 'pending_client_review', clientReviewRequestedAt: null })).toBeNull();
  });

  it('computeAutoPublishDeadline is clientReviewRequestedAt + the window for a pending_client_review row', async () => {
    const { computeAutoPublishDeadline, SEO_DRAFT_CLIENT_REVIEW_WINDOW_DAYS } = await import('@/lib/seo-draft-auto-publish');
    const deadline = computeAutoPublishDeadline({ status: 'pending_client_review', clientReviewRequestedAt: NOW });
    expect(deadline).toEqual(new Date(NOW.getTime() + SEO_DRAFT_CLIENT_REVIEW_WINDOW_DAYS * DAY_MS));
  });
});

describe('sweepAutoPublishableSeoDrafts', () => {
  it('only queries pending_client_review rows past the client review window', async () => {
    await sweep();
    const call = mockState.draftFindMany.mock.calls[0][0];
    expect(call.where.status).toBe('pending_client_review');
    expect(call.where.clientReviewRequestedAt.lte).toEqual(new Date('2026-09-07T12:00:00.000Z'));
  });

  it('publishes each candidate through the shared lib, with the system reviewer', async () => {
    mockState.draftFindMany.mockResolvedValue([
      { id: 'draft_1', clientId: 'client_1' },
      { id: 'draft_2', clientId: 'client_2' },
    ]);
    mockState.publishAfterClientReview
      .mockResolvedValueOnce({ status: 'published' })
      .mockResolvedValueOnce({ status: 'publish_failed', publishError: 'wordpress_error:401' });

    const result = await sweep();

    expect(result.due).toBe(2);
    expect(result.processed).toBe(2);
    expect(result.published).toBe(1);
    expect(result.publishFailed).toBe(1);
    expect(mockState.publishAfterClientReview).toHaveBeenNthCalledWith(1, prismaMock, {
      draftId: 'draft_1',
      clientId: 'client_1',
      clientReviewedBy: 'system:auto_publish_client_timeout',
    });
  });

  it('isolates one failing draft so the rest of the tick still gets published', async () => {
    mockState.draftFindMany.mockResolvedValue([
      { id: 'draft_1', clientId: 'client_1' },
      { id: 'draft_2', clientId: 'client_2' },
    ]);
    mockState.publishAfterClientReview
      .mockRejectedValueOnce(new Error('wordpress unreachable'))
      .mockResolvedValueOnce({ status: 'published' });

    const result = await sweep();

    expect(result.published).toBe(1);
    expect(result.failed).toEqual([{ draftId: 'draft_1', clientId: 'client_1', error: 'wordpress unreachable' }]);
    expect(mockState.logError).toHaveBeenCalled();
  });

  it('never throws even when the initial query fails', async () => {
    mockState.draftFindMany.mockRejectedValue(new Error('db down'));
    await expect(sweep()).resolves.toBeDefined();
    const result = await sweep();
    expect(result.due).toBe(0);
    expect(result.failed.length).toBe(1);
  });

  it('caps the batch per tick, leaving the rest for the next one', async () => {
    mockState.draftFindMany.mockResolvedValue([
      { id: 'd1', clientId: 'c1' },
      { id: 'd2', clientId: 'c2' },
      { id: 'd3', clientId: 'c3' },
      { id: 'd4', clientId: 'c4' },
    ]);
    const result = await sweep();
    expect(result.due).toBe(4);
    expect(result.processed).toBeLessThan(4);
    expect(mockState.publishAfterClientReview).toHaveBeenCalledTimes(result.processed);
  });
});
