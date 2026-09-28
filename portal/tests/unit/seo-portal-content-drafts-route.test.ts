// =============================================================================
// SEO con IA, Fase 6 — unit tests for
// PATCH /api/portal/seo/content-drafts/[draftId] — the client's own
// approve/reject decision, the last gate before WordPress. Same
// mocking conventions as seo-content-review-route.test.ts (the
// operator's sibling route): wordpress-publish.ts and prisma are
// mocked directly, exercising the real seo-content-review.ts
// implementation, not a mock of it.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  getSession: vi.fn(),
  resolveClientFromSession: vi.fn(),
  draftFindFirst: vi.fn(),
  draftFindUnique: vi.fn(),
  draftUpdate: vi.fn(),
  draftUpdateMany: vi.fn(),
  profileFindUnique: vi.fn(),
  publishDraftToWordPress: vi.fn(),
  hasWordPressCredentials: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/session', () => ({
  getSession: (...a: unknown[]) => mockState.getSession(...a),
}));

vi.mock('@/lib/portal-session', () => ({
  resolveClientFromSession: (...a: unknown[]) => mockState.resolveClientFromSession(...a),
}));

vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

vi.mock('@/lib/wordpress-publish', () => ({
  publishDraftToWordPress: (...a: unknown[]) => mockState.publishDraftToWordPress(...a),
  hasWordPressCredentials: (...a: unknown[]) => mockState.hasWordPressCredentials(...a),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    seoContentDraft: {
      findFirst: (...a: unknown[]) => mockState.draftFindFirst(...a),
      findUnique: (...a: unknown[]) => mockState.draftFindUnique(...a),
      update: (...a: unknown[]) => mockState.draftUpdate(...a),
      updateMany: (...a: unknown[]) => mockState.draftUpdateMany(...a),
    },
    seoProfile: {
      findUnique: (...a: unknown[]) => mockState.profileFindUnique(...a),
    },
  },
}));

import { PATCH } from '@/app/api/portal/seo/content-drafts/[draftId]/route';

const SESSION_OK = { hasClientAccess: true };
const RESOLVED = { clientId: 'client_1', email: 'a@b.com', source: 'database' as const };
const DRAFT = { id: 'draft_1', status: 'pending_client_review' };
const FULL_DRAFT = { id: 'draft_1', profileId: 'profile_1', title: 'Título', bodyHtml: '<p>Cuerpo</p>', metaDescription: null };
const PROFILE_WITH_CREDS = {
  wordpressUrl: 'https://negocio.example',
  wordpressUsername: 'kairikos',
  wordpressAppPasswordCiphertext: Buffer.from('ct'),
  wordpressAppPasswordIv: Buffer.from('iv'),
  wordpressAppPasswordTag: Buffer.from('tag'),
};

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

async function patch(draftId: string, body: unknown) {
  return PATCH(makeRequest(body), { params: { draftId } });
}

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.getSession.mockReset().mockResolvedValue(SESSION_OK);
  mockState.resolveClientFromSession.mockReset().mockResolvedValue(RESOLVED);
  mockState.draftFindFirst.mockReset().mockResolvedValue(DRAFT);
  mockState.draftFindUnique.mockReset().mockResolvedValue(FULL_DRAFT);
  mockState.draftUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  mockState.draftUpdate.mockReset().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ ...DRAFT, ...data }),
  );
  mockState.profileFindUnique.mockReset().mockResolvedValue(PROFILE_WITH_CREDS);
  mockState.hasWordPressCredentials.mockReset().mockReturnValue(true);
  mockState.publishDraftToWordPress.mockReset().mockResolvedValue({
    ok: true,
    postId: '42',
    postUrl: 'https://negocio.example/articulo',
  });
  mockState.logError.mockReset();
});

describe('PATCH — auth/validation guards', () => {
  it('401s without a valid client session', async () => {
    mockState.getSession.mockResolvedValue({ hasClientAccess: false });
    const res = await patch('draft_1', { action: 'approve' });
    expect(res.status).toBe(401);
    expect(mockState.draftFindFirst).not.toHaveBeenCalled();
  });

  it('401s when the session cannot be resolved to a client', async () => {
    mockState.resolveClientFromSession.mockResolvedValue(null);
    const res = await patch('draft_1', { action: 'approve' });
    expect(res.status).toBe(401);
  });

  it('400s on an unknown action', async () => {
    const res = await patch('draft_1', { action: 'delete' });
    expect(res.status).toBe(400);
  });

  it("400s when action is 'reject' without a rejectionReason", async () => {
    const res = await patch('draft_1', { action: 'reject' });
    expect(res.status).toBe(400);
  });

  it('404s when the draft does not exist for this client', async () => {
    mockState.draftFindFirst.mockResolvedValue(null);
    const res = await patch('draft_missing', { action: 'approve' });
    expect(res.status).toBe(404);
    // Scoped to this client's own drafts, not any draftId.
    expect(mockState.draftFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'draft_missing', clientId: 'client_1' } }),
    );
  });

  it("409s when the draft is not currently 'pending_client_review'", async () => {
    mockState.draftFindFirst.mockResolvedValue({ ...DRAFT, status: 'drafted' });
    const res = await patch('draft_1', { action: 'approve' });
    expect(res.status).toBe(409);
    expect(mockState.draftUpdate).not.toHaveBeenCalled();
  });

  it('503s when the database is not configured', async () => {
    mockState.isDatabaseConfigured = false;
    const res = await patch('draft_1', { action: 'approve' });
    expect(res.status).toBe(503);
  });

  it('GET is not allowed', async () => {
    const { GET } = await import('@/app/api/portal/seo/content-drafts/[draftId]/route');
    const res = GET();
    expect(res.status).toBe(405);
  });
});

describe('PATCH action=reject', () => {
  it('rejects with the client actor convention, without attempting to publish', async () => {
    const res = await patch('draft_1', { action: 'reject', rejectionReason: 'tono equivocado' });
    expect(res.status).toBe(200);
    expect(mockState.draftUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'rejected',
          clientReviewedBy: 'client:client_1',
          rejectionReason: 'tono equivocado',
        }),
      }),
    );
    expect(mockState.publishDraftToWordPress).not.toHaveBeenCalled();
  });
});

describe('PATCH action=approve — publishes to WordPress', () => {
  it('stamps clientReviewedBy, publishes successfully, and returns status=published', async () => {
    const res = await patch('draft_1', { action: 'approve' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, draftId: 'draft_1', status: 'published', publishError: undefined });

    // Quién aprobó viaja en el mismo update que reclama el borrador
    // (revisión de seguridad 22/09/2026, ver attemptPublishDraft).
    expect(mockState.draftUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ clientReviewedBy: 'client:client_1', status: 'publishing' }),
      }),
    );
    expect(mockState.publishDraftToWordPress).toHaveBeenCalledWith(PROFILE_WITH_CREDS, {
      title: FULL_DRAFT.title,
      bodyHtml: FULL_DRAFT.bodyHtml,
      metaDescription: FULL_DRAFT.metaDescription,
    });
    expect(mockState.draftUpdate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({ status: 'published', wordpressPostId: '42', wordpressPostUrl: 'https://negocio.example/articulo' }),
      }),
    );
  });

  it('marks publish_failed (not a request failure) when WordPress credentials are missing', async () => {
    mockState.hasWordPressCredentials.mockReturnValue(false);
    const res = await patch('draft_1', { action: 'approve' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, draftId: 'draft_1', status: 'publish_failed', publishError: 'missing_wordpress_credentials' });
  });

  it('a draft belonging to another client 404s, never reaching WordPress', async () => {
    mockState.draftFindFirst.mockResolvedValue(null);
    const res = await patch('draft_1', { action: 'approve' });
    expect(res.status).toBe(404);
    expect(mockState.publishDraftToWordPress).not.toHaveBeenCalled();
  });

  it('500s cleanly and logs when the write itself throws', async () => {
    mockState.draftUpdate.mockRejectedValueOnce(new Error('db down'));
    const res = await patch('draft_1', { action: 'approve' });
    expect(res.status).toBe(500);
    expect(mockState.logError).toHaveBeenCalled();
  });
});
