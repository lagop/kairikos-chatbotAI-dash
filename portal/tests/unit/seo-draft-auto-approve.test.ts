// =============================================================================
// SEO con IA, Fase 5 — unit tests for lib/seo-draft-auto-approve.ts.
// approveDraft (lib/seo-content-review.ts) is mocked here — it already
// has full coverage via seo-content-review-route.test.ts, which exercises
// the real implementation. This file focuses on WHICH drafts the sweep
// picks and how it isolates failures.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  draftFindMany: vi.fn(),
  approveDraft: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/seo-content-review', () => ({
  approveDraft: (...a: unknown[]) => mockState.approveDraft(...a),
  AUTO_APPROVE_REVIEWED_BY: 'system:auto_approve',
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
  mockState.approveDraft.mockResolvedValue({ status: 'published' });
});

async function sweep(now = NOW) {
  const { sweepAutoApprovableSeoDrafts } = await import('@/lib/seo-draft-auto-approve');
  return sweepAutoApprovableSeoDrafts(prismaMock, { now });
}

describe('isDraftPastVetoWindow / computeAutoApproveDeadline', () => {
  it('is never due without a generatedAt', async () => {
    const { isDraftPastVetoWindow } = await import('@/lib/seo-draft-auto-approve');
    expect(isDraftPastVetoWindow(null, NOW)).toBe(false);
  });

  it('is due once the window elapses, not before', async () => {
    const { isDraftPastVetoWindow, SEO_DRAFT_AUTO_APPROVE_VETO_WINDOW_DAYS } = await import('@/lib/seo-draft-auto-approve');
    const justInside = new Date(NOW.getTime() - (SEO_DRAFT_AUTO_APPROVE_VETO_WINDOW_DAYS - 1) * DAY_MS);
    const justPast = new Date(NOW.getTime() - (SEO_DRAFT_AUTO_APPROVE_VETO_WINDOW_DAYS + 1) * DAY_MS);
    expect(isDraftPastVetoWindow(justInside, NOW)).toBe(false);
    expect(isDraftPastVetoWindow(justPast, NOW)).toBe(true);
  });

  it('computeAutoApproveDeadline is null unless the draft is still drafted', async () => {
    const { computeAutoApproveDeadline } = await import('@/lib/seo-draft-auto-approve');
    expect(computeAutoApproveDeadline({ status: 'approved', generatedAt: NOW })).toBeNull();
    expect(computeAutoApproveDeadline({ status: 'drafted', generatedAt: null })).toBeNull();
  });

  it('computeAutoApproveDeadline is generatedAt + the window for a drafted row', async () => {
    const { computeAutoApproveDeadline, SEO_DRAFT_AUTO_APPROVE_VETO_WINDOW_DAYS } = await import('@/lib/seo-draft-auto-approve');
    const deadline = computeAutoApproveDeadline({ status: 'drafted', generatedAt: NOW });
    expect(deadline).toEqual(new Date(NOW.getTime() + SEO_DRAFT_AUTO_APPROVE_VETO_WINDOW_DAYS * DAY_MS));
  });
});

describe('sweepAutoApprovableSeoDrafts', () => {
  it('only queries drafted rows past the veto window', async () => {
    await sweep();
    const call = mockState.draftFindMany.mock.calls[0][0];
    expect(call.where.status).toBe('drafted');
    expect(call.where.generatedAt.lte).toEqual(new Date('2026-09-07T12:00:00.000Z'));
  });

  it('approves each candidate through the shared lib, with the system reviewer', async () => {
    mockState.draftFindMany.mockResolvedValue([
      { id: 'draft_1', clientId: 'client_1' },
      { id: 'draft_2', clientId: 'client_2' },
    ]);
    mockState.approveDraft
      .mockResolvedValueOnce({ status: 'published' })
      .mockResolvedValueOnce({ status: 'publish_failed', publishError: 'wordpress_error:401' });

    const result = await sweep();

    expect(result.due).toBe(2);
    expect(result.processed).toBe(2);
    expect(result.approved).toBe(2);
    expect(result.published).toBe(1);
    expect(result.publishFailed).toBe(1);
    expect(mockState.approveDraft).toHaveBeenNthCalledWith(1, prismaMock, {
      draftId: 'draft_1',
      clientId: 'client_1',
      reviewedBy: 'system:auto_approve',
    });
  });

  it('isolates one failing draft so the rest of the tick still gets approved', async () => {
    mockState.draftFindMany.mockResolvedValue([
      { id: 'draft_1', clientId: 'client_1' },
      { id: 'draft_2', clientId: 'client_2' },
    ]);
    mockState.approveDraft
      .mockRejectedValueOnce(new Error('wordpress unreachable'))
      .mockResolvedValueOnce({ status: 'published' });

    const result = await sweep();

    expect(result.approved).toBe(1);
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
    expect(mockState.approveDraft).toHaveBeenCalledTimes(result.processed);
  });
});
