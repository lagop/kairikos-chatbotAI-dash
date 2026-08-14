// =============================================================================
// WP-22c — unit tests for src/lib/review-reply.ts: publishing (human or
// auto) and the auto-publish sweep hooked into google-review-sync.ts.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  getValidAccessToken: vi.fn(),
  publishReviewReply: vi.fn(),
  generateReviewReplyDraft: vi.fn(),
  reviewUpdate: vi.fn(),
  reviewFindMany: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/google-business', () => ({
  getValidAccessToken: (...args: unknown[]) => mockState.getValidAccessToken(...args),
  publishReviewReply: (...args: unknown[]) => mockState.publishReviewReply(...args),
}));

vi.mock('@/lib/review-reply-ai', () => ({
  generateReviewReplyDraft: (...args: unknown[]) => mockState.generateReviewReplyDraft(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    googleReview: {
      update: (...args: unknown[]) => mockState.reviewUpdate(...args),
      findMany: (...args: unknown[]) => mockState.reviewFindMany(...args),
    },
  },
}));

vi.mock('@/lib/observability', () => ({
  logError: (...args: unknown[]) => mockState.logError(...args),
}));

import { publishReplyToReview, autoReplyToUnansweredReviews } from '@/lib/review-reply';

function baseConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn_1',
    clientId: 'client_1',
    status: 'active',
    autoPublishReplies: false,
    ...overrides,
  } as never;
}

beforeEach(() => {
  mockState.getValidAccessToken.mockReset().mockResolvedValue('at_1');
  mockState.publishReviewReply.mockReset().mockResolvedValue({ ok: true });
  mockState.generateReviewReplyDraft.mockReset();
  mockState.reviewUpdate.mockReset().mockResolvedValue({});
  mockState.reviewFindMany.mockReset();
  mockState.logError.mockReset();
});

describe('publishReplyToReview', () => {
  const review = { id: 'review_1', googleReviewId: 'accounts/1/locations/2/reviews/3' };

  it('short-circuits with needs_reconnect when the connection is already in that state', async () => {
    const result = await publishReplyToReview(baseConnection({ status: 'needs_reconnect' }), review, 'text', 'client:c1');
    expect(result).toEqual({ ok: false, error: 'needs_reconnect' });
    expect(mockState.getValidAccessToken).not.toHaveBeenCalled();
  });

  it('short-circuits with not_active for any other non-active status', async () => {
    const result = await publishReplyToReview(baseConnection({ status: 'revoked' }), review, 'text', 'client:c1');
    expect(result).toEqual({ ok: false, error: 'not_active' });
  });

  it('returns no_access_token when getValidAccessToken fails', async () => {
    mockState.getValidAccessToken.mockResolvedValueOnce(null);
    const result = await publishReplyToReview(baseConnection(), review, 'text', 'client:c1');
    expect(result).toEqual({ ok: false, error: 'no_access_token' });
    expect(mockState.publishReviewReply).not.toHaveBeenCalled();
  });

  it('passes through needs_reconnect from publishReviewReply', async () => {
    mockState.publishReviewReply.mockResolvedValueOnce({ ok: false, error: 'needs_reconnect' });
    const result = await publishReplyToReview(baseConnection(), review, 'text', 'client:c1');
    expect(result).toEqual({ ok: false, error: 'needs_reconnect' });
    expect(mockState.reviewUpdate).not.toHaveBeenCalled();
  });

  it('publishes exactly the comment passed in and stamps approvedBy/publishedAt on success', async () => {
    const result = await publishReplyToReview(baseConnection(), review, 'Mi respuesta editada', 'client:c1');
    expect(result).toEqual({ ok: true });
    expect(mockState.publishReviewReply).toHaveBeenCalledWith('at_1', 'accounts/1/locations/2/reviews/3', 'Mi respuesta editada');
    expect(mockState.reviewUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'review_1' },
        data: expect.objectContaining({
          replyComment: 'Mi respuesta editada',
          replyApprovedBy: 'client:c1',
        }),
      }),
    );
  });

  it('stamps approvedBy="auto" when called from the auto-publish path', async () => {
    await publishReplyToReview(baseConnection(), review, 'x', 'auto');
    expect(mockState.reviewUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ replyApprovedBy: 'auto' }) }),
    );
  });
});

describe('autoReplyToUnansweredReviews', () => {
  it('is a no-op when autoPublishReplies is disabled', async () => {
    const result = await autoReplyToUnansweredReviews(baseConnection({ autoPublishReplies: false }), 'X');
    expect(result).toEqual({ drafted: 0, published: 0 });
    expect(mockState.reviewFindMany).not.toHaveBeenCalled();
  });

  it('only queries reviews with no existing reply and no prior draft attempt', async () => {
    mockState.reviewFindMany.mockResolvedValueOnce([]);
    await autoReplyToUnansweredReviews(baseConnection({ autoPublishReplies: true }), 'X');
    expect(mockState.reviewFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { connectionId: 'conn_1', replyComment: null, aiDraftReply: null } }),
    );
  });

  it('drafts and publishes each candidate, stamping approvedBy=auto', async () => {
    mockState.reviewFindMany.mockResolvedValueOnce([
      { id: 'review_1', googleReviewId: 'accounts/1/locations/2/reviews/3', reviewerName: 'Ana', starRating: 5, comment: 'Genial' },
    ]);
    mockState.generateReviewReplyDraft.mockResolvedValueOnce({ ok: true, draft: 'Gracias Ana' });

    const result = await autoReplyToUnansweredReviews(baseConnection({ autoPublishReplies: true }), 'X');

    expect(result).toEqual({ drafted: 1, published: 1 });
    expect(mockState.reviewUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ aiDraftReply: 'Gracias Ana' }) }),
    );
    expect(mockState.publishReviewReply).toHaveBeenCalledWith('at_1', 'accounts/1/locations/2/reviews/3', 'Gracias Ana');
  });

  it('skips a candidate when draft generation is skipped (no API key) — drafted stays 0', async () => {
    mockState.reviewFindMany.mockResolvedValueOnce([
      { id: 'review_1', googleReviewId: 'x', reviewerName: null, starRating: 5, comment: null },
    ]);
    mockState.generateReviewReplyDraft.mockResolvedValueOnce({ ok: true, skipped: true, reason: 'no_api_key' });

    const result = await autoReplyToUnansweredReviews(baseConnection({ autoPublishReplies: true }), 'X');
    expect(result).toEqual({ drafted: 0, published: 0 });
    expect(mockState.publishReviewReply).not.toHaveBeenCalled();
  });

  it('isolates a failure in one candidate — the sweep continues for the rest', async () => {
    mockState.reviewFindMany.mockResolvedValueOnce([
      { id: 'review_bad', googleReviewId: 'x', reviewerName: null, starRating: 1, comment: null },
      { id: 'review_ok', googleReviewId: 'y', reviewerName: null, starRating: 5, comment: null },
    ]);
    mockState.generateReviewReplyDraft
      .mockRejectedValueOnce(new Error('anthropic down'))
      .mockResolvedValueOnce({ ok: true, draft: 'Gracias' });

    const result = await autoReplyToUnansweredReviews(baseConnection({ autoPublishReplies: true }), 'X');
    expect(result).toEqual({ drafted: 1, published: 1 });
    expect(mockState.logError).toHaveBeenCalled();
  });

  it('does not increment published when the publish step fails after a successful draft', async () => {
    mockState.reviewFindMany.mockResolvedValueOnce([
      { id: 'review_1', googleReviewId: 'x', reviewerName: null, starRating: 5, comment: null },
    ]);
    mockState.generateReviewReplyDraft.mockResolvedValueOnce({ ok: true, draft: 'Gracias' });
    mockState.publishReviewReply.mockResolvedValueOnce({ ok: false, error: 'needs_reconnect' });

    const result = await autoReplyToUnansweredReviews(baseConnection({ autoPublishReplies: true }), 'X');
    expect(result).toEqual({ drafted: 1, published: 0 });
  });
});
