// =============================================================================
// Revisión de seguridad del 22/09/2026 — un doble clic en "aprobar" (o el
// cliente aprobando justo cuando pasa el barrido de publicación automática)
// publicaba el mismo artículo DOS veces en el WordPress del cliente. Ahora
// attemptPublishDraft reclama la fila con un updateMany condicional antes
// de llamar a WordPress. Ver src/lib/seo-content-review.ts.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const mockState = vi.hoisted(() => ({
  publishDraftToWordPress: vi.fn(),
  hasWordPressCredentials: vi.fn(),
}));

vi.mock('@/lib/wordpress-publish', () => ({
  publishDraftToWordPress: (...a: unknown[]) => mockState.publishDraftToWordPress(...a),
  hasWordPressCredentials: (...a: unknown[]) => mockState.hasWordPressCredentials(...a),
}));
vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));

import { attemptPublishDraft, publishAfterClientReview } from '@/lib/seo-content-review';

const updateMany = vi.fn();
const update = vi.fn();
const findUniqueDraft = vi.fn();
const findUniqueProfile = vi.fn();
const prisma = {
  seoContentDraft: { updateMany, update, findUnique: findUniqueDraft },
  seoProfile: { findUnique: findUniqueProfile },
} as unknown as PrismaClient;

beforeEach(() => {
  updateMany.mockReset().mockResolvedValue({ count: 1 });
  update.mockReset().mockResolvedValue({});
  findUniqueDraft
    .mockReset()
    .mockResolvedValue({ id: 'd1', profileId: 'p1', title: 'T', bodyHtml: '<p>x</p>', metaDescription: null });
  findUniqueProfile.mockReset().mockResolvedValue({ wordpressUrl: 'https://example.com' });
  mockState.hasWordPressCredentials.mockReset().mockReturnValue(true);
  mockState.publishDraftToWordPress
    .mockReset()
    .mockResolvedValue({ ok: true, postId: 7, postUrl: 'https://example.com/?p=7' });
});

describe('attemptPublishDraft — atomic claim', () => {
  it('claims the row from the caller-given status (or a stale publishing) before touching WordPress', async () => {
    await attemptPublishDraft(prisma, 'd1', 'c1', { fromStatus: 'publish_failed' });
    const { where, data } = updateMany.mock.calls[0][0];
    expect(where.id).toBe('d1');
    expect(where.OR[0]).toEqual({ status: 'publish_failed' });
    expect(where.OR[1].status).toBe('publishing');
    const cutoff = where.OR[1].publishedAt.lt as Date;
    expect(Date.now() - cutoff.getTime()).toBeGreaterThanOrEqual(10 * 60 * 1000 - 1000);
    expect(data.status).toBe('publishing');
    expect(updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mockState.publishDraftToWordPress.mock.invocationCallOrder[0],
    );
  });

  it('the request that loses the claim never calls WordPress and writes nothing', async () => {
    updateMany.mockResolvedValueOnce({ count: 0 });
    const result = await attemptPublishDraft(prisma, 'd1', 'c1', { fromStatus: 'pending_client_review' });
    expect(result).toEqual({ ok: false, error: 'not_publishable', notClaimed: true });
    expect(mockState.publishDraftToWordPress).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('a failed publish releases the claim to publish_failed and clears the start time', async () => {
    mockState.publishDraftToWordPress.mockResolvedValueOnce({ ok: false, error: 'wp_401' });
    await attemptPublishDraft(prisma, 'd1', 'c1', { fromStatus: 'pending_client_review' });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: { status: 'publish_failed', publishError: 'wp_401', publishedAt: null },
    });
  });

  it('an incomplete draft does not stay stuck in publishing', async () => {
    findUniqueDraft.mockResolvedValueOnce({ id: 'd1', profileId: 'p1', title: null, bodyHtml: null });
    const result = await attemptPublishDraft(prisma, 'd1', 'c1', { fromStatus: 'pending_client_review' });
    expect(result).toEqual({ ok: false, error: 'draft_incomplete' });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'publish_failed' }) }),
    );
  });
});

describe('publishAfterClientReview', () => {
  it('records who approved in the same write that claims the row', async () => {
    await publishAfterClientReview(prisma, { draftId: 'd1', clientId: 'c1', clientReviewedBy: 'client:c1' });
    const { where, data } = updateMany.mock.calls[0][0];
    expect(where.OR[0]).toEqual({ status: 'pending_client_review' });
    expect(data).toMatchObject({ status: 'publishing', clientReviewedBy: 'client:c1' });
    expect(data.clientReviewedAt).toBeInstanceOf(Date);
  });

  it('reports not_publishable (not publish_failed) to the second click', async () => {
    updateMany.mockResolvedValueOnce({ count: 0 });
    const result = await publishAfterClientReview(prisma, { draftId: 'd1', clientId: 'c1', clientReviewedBy: 'client:c1' });
    expect(result).toEqual({ status: 'not_publishable' });
    expect(mockState.publishDraftToWordPress).not.toHaveBeenCalled();
  });
});
