// =============================================================================
// SEO con IA, Fase C — unit tests for
// PATCH /api/internal/seo/content-drafts/[id]. Same mocking conventions
// as leads-enrich-route.test.ts.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  draftFindUnique: vi.fn(),
  draftUpdate: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    seoContentDraft: {
      findUnique: (...a: unknown[]) => mockState.draftFindUnique(...a),
      update: (...a: unknown[]) => mockState.draftUpdate(...a),
    },
  },
}));

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return {
    json: async () => body,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

const VALID_KEY = 'test_portal_api_key';
const EXISTING_DRAFT = {
  id: 'draft_1',
  profileId: 'profile_1',
  clientId: 'client_1',
  status: 'pending_generation',
};

const VALID_BODY = {
  title: 'Cómo elegir un cerrajero de confianza',
  bodyHtml: '<p>Contenido del artículo.</p>',
  targetKeyword: 'cerrajero de confianza',
  metaDescription: 'Guía práctica para elegir un cerrajero de confianza cerca de ti.',
};

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.draftFindUnique.mockReset().mockResolvedValue(EXISTING_DRAFT);
  mockState.draftUpdate.mockReset().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ ...EXISTING_DRAFT, ...data }),
  );
  process.env.PORTAL_API_KEY = VALID_KEY;
});

afterEach(() => {
  delete process.env.PORTAL_API_KEY;
});

async function patch(id: string, body: unknown, headers: Record<string, string> = {}) {
  const { PATCH } = await import('@/app/api/internal/seo/content-drafts/[id]/route');
  return PATCH(makeRequest(body, headers), { params: { id } });
}

describe('PATCH /api/internal/seo/content-drafts/[id]', () => {
  it('401s without a matching internal key', async () => {
    const res = await patch('draft_1', VALID_BODY);
    expect(res.status).toBe(401);
    expect(mockState.draftFindUnique).not.toHaveBeenCalled();
  });

  it('400s when title is missing', async () => {
    const { title, ...rest } = VALID_BODY;
    const res = await patch('draft_1', rest, { 'x-kairikos-internal-key': VALID_KEY });
    expect(res.status).toBe(400);
    expect(mockState.draftFindUnique).not.toHaveBeenCalled();
  });

  it('400s when bodyHtml is missing', async () => {
    const { bodyHtml, ...rest } = VALID_BODY;
    const res = await patch('draft_1', rest, { 'x-kairikos-internal-key': VALID_KEY });
    expect(res.status).toBe(400);
  });

  it('404s when the draft id does not exist', async () => {
    mockState.draftFindUnique.mockResolvedValueOnce(null);
    const res = await patch('draft_missing', VALID_BODY, { 'x-kairikos-internal-key': VALID_KEY });
    expect(res.status).toBe(404);
  });

  it('409s when the draft has already been resolved (approved/rejected/etc.) — never overwrites a decision', async () => {
    mockState.draftFindUnique.mockResolvedValueOnce({ ...EXISTING_DRAFT, status: 'approved' });
    const res = await patch('draft_1', VALID_BODY, { 'x-kairikos-internal-key': VALID_KEY });
    expect(res.status).toBe(409);
    expect(mockState.draftUpdate).not.toHaveBeenCalled();
  });

  it('fills the draft and flips status to drafted on a valid pending_generation draft', async () => {
    const res = await patch('draft_1', VALID_BODY, { 'x-kairikos-internal-key': VALID_KEY });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, draftId: 'draft_1' });

    expect(mockState.draftUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'draft_1' },
        data: expect.objectContaining({
          title: VALID_BODY.title,
          bodyHtml: VALID_BODY.bodyHtml,
          targetKeyword: VALID_BODY.targetKeyword,
          metaDescription: VALID_BODY.metaDescription,
          status: 'drafted',
        }),
      }),
    );
  });

  it('accepts a draft without the optional targetKeyword/metaDescription', async () => {
    const { targetKeyword, metaDescription, ...minimal } = VALID_BODY;
    const res = await patch('draft_1', minimal, { 'x-kairikos-internal-key': VALID_KEY });
    expect(res.status).toBe(200);
    expect(mockState.draftUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ targetKeyword: null, metaDescription: null }) }),
    );
  });

  it('503s when the database is not configured', async () => {
    mockState.isDatabaseConfigured = false;
    const res = await patch('draft_1', VALID_BODY, { 'x-kairikos-internal-key': VALID_KEY });
    expect(res.status).toBe(503);
  });

  it('GET is not allowed', async () => {
    const { GET } = await import('@/app/api/internal/seo/content-drafts/[id]/route');
    const res = GET();
    expect(res.status).toBe(405);
  });
});
