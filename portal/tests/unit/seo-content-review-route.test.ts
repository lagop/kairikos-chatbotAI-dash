// =============================================================================
// SEO con IA, Fase C — unit tests for
// PATCH /api/admin/portal/seo/[clientId]/content-drafts/[draftId]. Same
// conventions as seo-audit-route.test.ts, including the legacy-auth
// regression coverage. Covers approve (which now also attempts an
// immediate WordPress publish), reject, and retry_publish.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  authenticateAdminRequest: vi.fn(),
  operatorFindUnique: vi.fn(),
  draftFindFirst: vi.fn(),
  draftFindUnique: vi.fn(),
  draftUpdate: vi.fn(),
  profileFindUnique: vi.fn(),
  publishDraftToWordPress: vi.fn(),
  hasWordPressCredentials: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...a: unknown[]) => mockState.authenticateAdminRequest(...a),
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
    operator: { findUnique: (...a: unknown[]) => mockState.operatorFindUnique(...a) },
    seoContentDraft: {
      findFirst: (...a: unknown[]) => mockState.draftFindFirst(...a),
      findUnique: (...a: unknown[]) => mockState.draftFindUnique(...a),
      update: (...a: unknown[]) => mockState.draftUpdate(...a),
    },
    seoProfile: {
      findUnique: (...a: unknown[]) => mockState.profileFindUnique(...a),
    },
  },
}));

import { PATCH } from '@/app/api/admin/portal/seo/[clientId]/content-drafts/[draftId]/route';

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

async function patch(clientId: string, draftId: string, body: unknown) {
  return PATCH(makeRequest(body), { params: { clientId, draftId } });
}

const DRAFT = { id: 'draft_1', status: 'drafted' };
const FULL_DRAFT = { id: 'draft_1', profileId: 'profile_1', title: 'Título', bodyHtml: '<p>Cuerpo</p>', metaDescription: null };
const PROFILE_WITH_CREDS = {
  wordpressUrl: 'https://negocio.example',
  wordpressUsername: 'kairikos',
  wordpressAppPasswordCiphertext: Buffer.from('ct'),
  wordpressAppPasswordIv: Buffer.from('iv'),
  wordpressAppPasswordTag: Buffer.from('tag'),
};

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue({ ok: true, sessionId: 's1', operatorId: 'op_1' });
  mockState.operatorFindUnique.mockReset().mockResolvedValue({ email: 'op@kairikos.com' });
  mockState.draftFindFirst.mockReset().mockResolvedValue(DRAFT);
  mockState.draftFindUnique.mockReset().mockResolvedValue(FULL_DRAFT);
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
  it('401s without a valid admin session', async () => {
    mockState.authenticateAdminRequest.mockResolvedValue({ ok: false });
    const res = await patch('client_1', 'draft_1', { action: 'approve' });
    expect(res.status).toBe(401);
    expect(mockState.draftFindFirst).not.toHaveBeenCalled();
  });

  it('400s on an unknown action', async () => {
    const res = await patch('client_1', 'draft_1', { action: 'delete' });
    expect(res.status).toBe(400);
  });

  it("400s when action is 'reject' without a rejectionReason", async () => {
    const res = await patch('client_1', 'draft_1', { action: 'reject' });
    expect(res.status).toBe(400);
  });

  it('404s when the draft does not exist for this client', async () => {
    mockState.draftFindFirst.mockResolvedValue(null);
    const res = await patch('client_1', 'draft_missing', { action: 'approve' });
    expect(res.status).toBe(404);
  });

  it('503s when the database is not configured', async () => {
    mockState.isDatabaseConfigured = false;
    const res = await patch('client_1', 'draft_1', { action: 'approve' });
    expect(res.status).toBe(503);
  });

  it('GET is not allowed', async () => {
    const { GET } = await import('@/app/api/admin/portal/seo/[clientId]/content-drafts/[draftId]/route');
    const res = GET();
    expect(res.status).toBe(405);
  });
});

describe('PATCH action=reject', () => {
  it('rejects a drafted row with the given reason, without attempting to publish', async () => {
    const res = await patch('client_1', 'draft_1', { action: 'reject', rejectionReason: 'tono equivocado' });
    expect(res.status).toBe(200);
    expect(mockState.draftUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'rejected', rejectionReason: 'tono equivocado' }) }),
    );
    expect(mockState.publishDraftToWordPress).not.toHaveBeenCalled();
  });

  it("409s when the draft is not currently 'drafted'", async () => {
    mockState.draftFindFirst.mockResolvedValue({ ...DRAFT, status: 'approved' });
    const res = await patch('client_1', 'draft_1', { action: 'reject', rejectionReason: 'x' });
    expect(res.status).toBe(409);
    expect(mockState.draftUpdate).not.toHaveBeenCalled();
  });
});

describe('PATCH action=approve — approves then immediately attempts to publish', () => {
  it('marks approved, publishes successfully, and returns status=published', async () => {
    const res = await patch('client_1', 'draft_1', { action: 'approve' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, draftId: 'draft_1', status: 'published', publishError: undefined });

    expect(mockState.draftUpdate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ data: expect.objectContaining({ status: 'approved', reviewedBy: 'op@kairikos.com' }) }),
    );
    expect(mockState.publishDraftToWordPress).toHaveBeenCalledWith(
      PROFILE_WITH_CREDS,
      { title: FULL_DRAFT.title, bodyHtml: FULL_DRAFT.bodyHtml, metaDescription: FULL_DRAFT.metaDescription },
    );
    expect(mockState.draftUpdate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({ status: 'published', wordpressPostId: '42', wordpressPostUrl: 'https://negocio.example/articulo' }),
      }),
    );
  });

  it('marks the draft publish_failed (not a request failure) when WordPress credentials are missing', async () => {
    mockState.hasWordPressCredentials.mockReturnValue(false);
    const res = await patch('client_1', 'draft_1', { action: 'approve' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, draftId: 'draft_1', status: 'publish_failed', publishError: 'missing_wordpress_credentials' });
    expect(mockState.publishDraftToWordPress).not.toHaveBeenCalled();
    expect(mockState.draftUpdate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ data: expect.objectContaining({ status: 'publish_failed', publishError: 'missing_wordpress_credentials' }) }),
    );
  });

  it('marks the draft publish_failed when the WordPress request itself fails, but the approval still succeeds', async () => {
    mockState.publishDraftToWordPress.mockResolvedValue({ ok: false, error: 'wordpress_error:401:forbidden' });
    const res = await patch('client_1', 'draft_1', { action: 'approve' });
    const body = await res.json();
    expect(body.status).toBe('publish_failed');
    expect(body.publishError).toBe('wordpress_error:401:forbidden');
    expect(mockState.draftUpdate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ data: expect.objectContaining({ status: 'approved' }) }),
    );
  });

  it("409s when the draft is not currently 'drafted'", async () => {
    mockState.draftFindFirst.mockResolvedValue({ ...DRAFT, status: 'published' });
    const res = await patch('client_1', 'draft_1', { action: 'approve' });
    expect(res.status).toBe(409);
    expect(mockState.draftUpdate).not.toHaveBeenCalled();
  });

  it('the legacy KAIA_OPERATOR_API_KEY auth path reviews with a fallback reviewedBy instead of crashing', async () => {
    mockState.authenticateAdminRequest.mockResolvedValue({ ok: true, sessionId: 'legacy', operatorId: 'legacy' });
    const res = await patch('client_1', 'draft_1', { action: 'approve' });
    expect(res.status).toBe(200);
    expect(mockState.operatorFindUnique).not.toHaveBeenCalled();
    expect(mockState.draftUpdate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ data: expect.objectContaining({ reviewedBy: 'legacy_operator' }) }),
    );
  });

  it('500s cleanly and logs when the approve write itself throws', async () => {
    mockState.draftUpdate.mockRejectedValueOnce(new Error('db down'));
    const res = await patch('client_1', 'draft_1', { action: 'approve' });
    expect(res.status).toBe(500);
    expect(mockState.logError).toHaveBeenCalled();
  });
});

describe('PATCH action=retry_publish', () => {
  it("409s when the draft is not currently 'publish_failed'", async () => {
    mockState.draftFindFirst.mockResolvedValue({ ...DRAFT, status: 'drafted' });
    const res = await patch('client_1', 'draft_1', { action: 'retry_publish' });
    expect(res.status).toBe(409);
    expect(mockState.publishDraftToWordPress).not.toHaveBeenCalled();
  });

  it('retries the publish for a publish_failed draft and returns the new status', async () => {
    mockState.draftFindFirst.mockResolvedValue({ ...DRAFT, status: 'publish_failed' });
    const res = await patch('client_1', 'draft_1', { action: 'retry_publish' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, draftId: 'draft_1', publishError: undefined });
    expect(mockState.publishDraftToWordPress).toHaveBeenCalledTimes(1);
  });

  it('a second failed retry still responds ok:false with the error, without throwing', async () => {
    mockState.draftFindFirst.mockResolvedValue({ ...DRAFT, status: 'publish_failed' });
    mockState.publishDraftToWordPress.mockResolvedValue({ ok: false, error: 'still_unreachable' });
    const res = await patch('client_1', 'draft_1', { action: 'retry_publish' });
    const body = await res.json();
    expect(body).toEqual({ ok: false, draftId: 'draft_1', publishError: 'still_unreachable' });
  });
});
