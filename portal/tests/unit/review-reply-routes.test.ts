// =============================================================================
// WP-22c — unit tests for the reply API routes:
//   POST  /api/portal/google-business/reviews/[reviewId]/draft
//   POST  /api/portal/google-business/reviews/[reviewId]/publish
//   PATCH /api/portal/google-business/connection/auto-publish
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  resolveClientFromSession: vi.fn(),
  isDatabaseConfigured: true,
  isProductContracted: vi.fn(),
  reviewFindUnique: vi.fn(),
  reviewUpdate: vi.fn(),
  connectionFindUnique: vi.fn(),
  connectionFindFirst: vi.fn(),
  connectionUpdate: vi.fn(),
  findUniqueClient: vi.fn(),
  generateReviewReplyDraft: vi.fn(),
  publishReplyToReview: vi.fn(),
}));

vi.mock('@/lib/portal-session', () => ({
  resolveClientFromSession: (...args: unknown[]) => mockState.resolveClientFromSession(...args),
}));

vi.mock('@/lib/client-product-access', () => ({
  isProductContracted: (...args: unknown[]) => mockState.isProductContracted(...args),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    googleReview: {
      findUnique: (...args: unknown[]) => mockState.reviewFindUnique(...args),
      update: (...args: unknown[]) => mockState.reviewUpdate(...args),
    },
    googleBusinessConnection: {
      findUnique: (...args: unknown[]) => mockState.connectionFindUnique(...args),
      findFirst: (...args: unknown[]) => mockState.connectionFindFirst(...args),
      update: (...args: unknown[]) => mockState.connectionUpdate(...args),
    },
    chatbotClient: { findUnique: (...args: unknown[]) => mockState.findUniqueClient(...args) },
  },
}));

vi.mock('@/lib/review-reply-ai', () => ({
  generateReviewReplyDraft: (...args: unknown[]) => mockState.generateReviewReplyDraft(...args),
}));

vi.mock('@/lib/review-reply', () => ({
  publishReplyToReview: (...args: unknown[]) => mockState.publishReplyToReview(...args),
}));

const RESOLVED = { clientId: 'client_1', email: 'a@b.com', source: 'database' as const };

beforeEach(() => {
  mockState.resolveClientFromSession.mockReset().mockResolvedValue(RESOLVED);
  mockState.isDatabaseConfigured = true;
  mockState.isProductContracted.mockReset().mockResolvedValue(true);
  mockState.reviewFindUnique.mockReset().mockResolvedValue({
    id: 'review_1',
    clientId: 'client_1',
    connectionId: 'conn_1',
    googleReviewId: 'accounts/1/locations/2/reviews/3',
    reviewerName: 'Ana',
    starRating: 5,
    comment: 'Genial',
  });
  mockState.reviewUpdate.mockReset().mockResolvedValue({});
  mockState.connectionFindUnique.mockReset().mockResolvedValue({ id: 'conn_1', status: 'active' });
  mockState.connectionFindFirst.mockReset().mockResolvedValue({ id: 'conn_1', status: 'active' });
  mockState.connectionUpdate.mockReset().mockResolvedValue({ autoPublishReplies: true, autoPublishRepliesChangedAt: new Date() });
  mockState.findUniqueClient.mockReset().mockResolvedValue({ companyName: 'Clínica Orly', name: 'Orly' });
  mockState.generateReviewReplyDraft.mockReset().mockResolvedValue({ ok: true, draft: 'Gracias por tu reseña' });
  mockState.publishReplyToReview.mockReset().mockResolvedValue({ ok: true });
});

function makeRequest(body?: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

describe('POST .../reviews/[reviewId]/draft', () => {
  it('401s without a session', async () => {
    mockState.resolveClientFromSession.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/portal/google-business/reviews/[reviewId]/draft/route');
    const res = await POST(makeRequest(), { params: { reviewId: 'review_1' } });
    expect(res.status).toBe(401);
  });

  it('404s when the review belongs to a different client', async () => {
    mockState.reviewFindUnique.mockResolvedValueOnce({ id: 'review_1', clientId: 'someone_else' });
    const { POST } = await import('@/app/api/portal/google-business/reviews/[reviewId]/draft/route');
    const res = await POST(makeRequest(), { params: { reviewId: 'review_1' } });
    expect(res.status).toBe(404);
    expect(mockState.generateReviewReplyDraft).not.toHaveBeenCalled();
  });

  it('503s when AI drafting is not configured (skipped result)', async () => {
    mockState.generateReviewReplyDraft.mockResolvedValueOnce({ ok: true, skipped: true, reason: 'no_api_key' });
    const { POST } = await import('@/app/api/portal/google-business/reviews/[reviewId]/draft/route');
    const res = await POST(makeRequest(), { params: { reviewId: 'review_1' } });
    expect(res.status).toBe(503);
  });

  it('generates and persists the draft on success', async () => {
    const { POST } = await import('@/app/api/portal/google-business/reviews/[reviewId]/draft/route');
    const res = await POST(makeRequest(), { params: { reviewId: 'review_1' } });
    const body = await res.clone().json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ draft: 'Gracias por tu reseña' });
    expect(mockState.generateReviewReplyDraft).toHaveBeenCalledWith(
      expect.objectContaining({ businessName: 'Clínica Orly', reviewerName: 'Ana', starRating: 5 }),
    );
    expect(mockState.reviewUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ aiDraftReply: 'Gracias por tu reseña' }) }),
    );
  });
});

describe('POST .../reviews/[reviewId]/publish', () => {
  it('publishes exactly the body.comment text (not re-reading any stored draft)', async () => {
    const { POST } = await import('@/app/api/portal/google-business/reviews/[reviewId]/publish/route');
    const res = await POST(makeRequest({ comment: 'Mi respuesta editada a mano' }), { params: { reviewId: 'review_1' } });
    expect(res.status).toBe(200);
    expect(mockState.publishReplyToReview).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conn_1' }),
      expect.objectContaining({ id: 'review_1' }),
      'Mi respuesta editada a mano',
      'client:client_1',
    );
  });

  it('400s on an empty comment', async () => {
    const { POST } = await import('@/app/api/portal/google-business/reviews/[reviewId]/publish/route');
    const res = await POST(makeRequest({ comment: '' }), { params: { reviewId: 'review_1' } });
    expect(res.status).toBe(400);
  });

  it('returns 409 with error=needs_reconnect — a distinct status from a generic failure (AC)', async () => {
    mockState.publishReplyToReview.mockResolvedValueOnce({ ok: false, error: 'needs_reconnect' });
    const { POST } = await import('@/app/api/portal/google-business/reviews/[reviewId]/publish/route');
    const res = await POST(makeRequest({ comment: 'x' }), { params: { reviewId: 'review_1' } });
    const body = await res.clone().json();
    expect(res.status).toBe(409);
    expect(body.error).toBe('needs_reconnect');
  });

  it('returns 502 for a generic api_error', async () => {
    mockState.publishReplyToReview.mockResolvedValueOnce({ ok: false, error: 'api_error', detail: 'boom' });
    const { POST } = await import('@/app/api/portal/google-business/reviews/[reviewId]/publish/route');
    const res = await POST(makeRequest({ comment: 'x' }), { params: { reviewId: 'review_1' } });
    expect(res.status).toBe(502);
  });

  it('404s when the review belongs to a different client', async () => {
    mockState.reviewFindUnique.mockResolvedValueOnce({ id: 'review_1', clientId: 'someone_else', connectionId: 'conn_1' });
    const { POST } = await import('@/app/api/portal/google-business/reviews/[reviewId]/publish/route');
    const res = await POST(makeRequest({ comment: 'x' }), { params: { reviewId: 'review_1' } });
    expect(res.status).toBe(404);
    expect(mockState.publishReplyToReview).not.toHaveBeenCalled();
  });
});

describe('PATCH .../connection/auto-publish', () => {
  it('401s without a session', async () => {
    mockState.resolveClientFromSession.mockResolvedValueOnce(null);
    const { PATCH } = await import('@/app/api/portal/google-business/connection/auto-publish/route');
    const res = await PATCH(makeRequest({ enabled: true }));
    expect(res.status).toBe(401);
  });

  it('404s when the client has no active connection', async () => {
    mockState.connectionFindFirst.mockResolvedValueOnce(null);
    const { PATCH } = await import('@/app/api/portal/google-business/connection/auto-publish/route');
    const res = await PATCH(makeRequest({ enabled: true }));
    expect(res.status).toBe(404);
  });

  it('updates the setting and stamps who/when changed it', async () => {
    const { PATCH } = await import('@/app/api/portal/google-business/connection/auto-publish/route');
    const res = await PATCH(makeRequest({ enabled: true }));
    expect(res.status).toBe(200);
    expect(mockState.connectionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          autoPublishReplies: true,
          autoPublishRepliesChangedBy: 'client:client_1',
        }),
      }),
    );
  });
});
