// =============================================================================
// 23/11/2026 — las reseñas que Google ya no devuelve se marcan (removedAt) para
// que la web Premium no las publique (lib/google-review-sync.ts,
// markReviewsMissingFromSync). Una pasada vacía no marca nada.
// =============================================================================

import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/google-business', () => ({ getValidAccessToken: vi.fn() }));
vi.mock('@/lib/review-reply', () => ({ autoReplyToUnansweredReviews: vi.fn() }));
vi.mock('@/lib/review-alerts', () => ({ sweepNegativeReviewAlerts: vi.fn() }));
vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));

import { markReviewsMissingFromSync } from '@/lib/google-review-sync';

describe('markReviewsMissingFromSync', () => {
  it('marca las de esta ficha que no vinieron y siguen sin marcar', async () => {
    const updateMany = vi.fn(async () => ({ count: 2 }));
    const now = new Date('2026-11-23T05:00:00Z');
    const n = await markReviewsMissingFromSync({ googleReview: { updateMany } } as never, 'conn-1', ['a', 'b'], now);
    expect(n).toBe(2);
    expect(updateMany).toHaveBeenCalledWith({
      where: { connectionId: 'conn-1', removedAt: null, googleReviewId: { notIn: ['a', 'b'] } },
      data: { removedAt: now },
    });
  });

  it('una pasada sin reseñas no marca nada', async () => {
    const updateMany = vi.fn();
    expect(await markReviewsMissingFromSync({ googleReview: { updateMany } } as never, 'conn-1', [])).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
