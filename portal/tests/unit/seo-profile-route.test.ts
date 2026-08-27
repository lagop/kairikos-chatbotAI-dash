// =============================================================================
// SEO con IA, Fase A — unit tests for PATCH /api/portal/seo/profile.
// Same conventions as prospecting-campaign-route.test.ts (client-facing,
// lazy-create-on-first-save, session + isProductContracted-style gate).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  getSession: vi.fn(),
  resolveClientFromSession: vi.fn(),
  clientProductFindFirst: vi.fn(),
  profileFindUnique: vi.fn(),
  profileCreate: vi.fn(),
  profileUpdate: vi.fn(),
  auditCreate: vi.fn(),
  logError: vi.fn(),
}));

const mockTx = {
  seoProfile: {
    create: (...a: unknown[]) => mockState.profileCreate(...a),
    update: (...a: unknown[]) => mockState.profileUpdate(...a),
  },
  seoProfileAudit: { create: (...a: unknown[]) => mockState.auditCreate(...a) },
};

vi.mock('@/lib/session', () => ({
  getSession: (...a: unknown[]) => mockState.getSession(...a),
}));

vi.mock('@/lib/portal-session', () => ({
  resolveClientFromSession: (...a: unknown[]) => mockState.resolveClientFromSession(...a),
}));

vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    clientProduct: { findFirst: (...a: unknown[]) => mockState.clientProductFindFirst(...a) },
    seoProfile: { findUnique: (...a: unknown[]) => mockState.profileFindUnique(...a) },
    $transaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
  },
}));

import { PATCH } from '@/app/api/portal/seo/profile/route';

const SESSION_OK = { hasClientAccess: true };
const RESOLVED = { clientId: 'client_1', email: 'a@b.com', source: 'database' as const };
const CLIENT_PRODUCT = { id: 'cp_1', tenantId: 't1' };

function makeRequest(body?: unknown) {
  return { json: async () => body ?? null } as unknown as NextRequest;
}

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.getSession.mockReset().mockResolvedValue(SESSION_OK);
  mockState.resolveClientFromSession.mockReset().mockResolvedValue(RESOLVED);
  mockState.clientProductFindFirst.mockReset().mockResolvedValue(CLIENT_PRODUCT);
  mockState.profileFindUnique.mockReset().mockResolvedValue(null);
  mockState.profileCreate.mockReset().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'profile_1', ...data }),
  );
  mockState.profileUpdate.mockReset().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'profile_1', ...data }),
  );
  mockState.auditCreate.mockReset();
  mockState.logError.mockReset();
});

const VALID_BODY = { businessDescription: 'Peluquería de barrio', targetAudience: 'mujeres 25-55', siteUrl: 'https://tunegocio.es', cmsType: 'wordpress' };

describe('PATCH /api/portal/seo/profile', () => {
  it('401s without a client session', async () => {
    mockState.getSession.mockResolvedValue({ hasClientAccess: false });
    const res = await PATCH(makeRequest(VALID_BODY));
    expect(res.status).toBe(401);
  });

  it('400s on an empty body — at least one field is required', async () => {
    const res = await PATCH(makeRequest({}));
    expect(res.status).toBe(400);
    expect(mockState.clientProductFindFirst).not.toHaveBeenCalled();
  });

  it('400s on an invalid siteUrl', async () => {
    const res = await PATCH(makeRequest({ siteUrl: 'not-a-url' }));
    expect(res.status).toBe(400);
  });

  it('400s on an unrecognised cmsType', async () => {
    const res = await PATCH(makeRequest({ cmsType: 'shopify' }));
    expect(res.status).toBe(400);
  });

  it('403s a client without the seo product', async () => {
    mockState.clientProductFindFirst.mockResolvedValue(null);
    const res = await PATCH(makeRequest(VALID_BODY));
    expect(res.status).toBe(403);
    expect(mockState.profileCreate).not.toHaveBeenCalled();
  });

  it('creates a new profile on first save and audits action:created, actorType:client', async () => {
    const res = await PATCH(makeRequest(VALID_BODY));
    expect(res.status).toBe(200);
    expect(mockState.profileCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          clientId: 'client_1',
          clientProductId: 'cp_1',
          businessDescription: 'Peluquería de barrio',
          targetAudience: 'mujeres 25-55',
          siteUrl: 'https://tunegocio.es',
          cmsType: 'wordpress',
        }),
      }),
    );
    expect(mockState.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'created', actorType: 'client', actorEmail: 'client:client_1' }),
      }),
    );
    expect(mockState.profileUpdate).not.toHaveBeenCalled();
  });

  it('updates the existing profile on a subsequent save, merging only the provided fields', async () => {
    mockState.profileFindUnique.mockResolvedValue({
      id: 'profile_1',
      businessDescription: 'old description',
      targetAudience: 'old audience',
      toneOfVoice: 'formal',
      siteUrl: 'https://old.example',
      cmsType: 'wix',
    });
    const res = await PATCH(makeRequest({ businessDescription: 'new description' }));
    expect(res.status).toBe(200);
    expect(mockState.profileUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'profile_1' },
        data: expect.objectContaining({
          businessDescription: 'new description',
          targetAudience: 'old audience',
          toneOfVoice: 'formal',
          siteUrl: 'https://old.example',
          cmsType: 'wix',
        }),
      }),
    );
    expect(mockState.profileCreate).not.toHaveBeenCalled();
    expect(mockState.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'business_info_updated', actorType: 'client' }) }),
    );
  });

  it('never writes any WordPress/technical field — that is the operator route\'s job', async () => {
    await PATCH(makeRequest(VALID_BODY));
    const createCall = mockState.profileCreate.mock.calls[0][0].data;
    expect(createCall).not.toHaveProperty('wordpressUrl');
    expect(createCall).not.toHaveProperty('wordpressAppPasswordCiphertext');
  });

  it('503s when the database is not configured', async () => {
    mockState.isDatabaseConfigured = false;
    const res = await PATCH(makeRequest(VALID_BODY));
    expect(res.status).toBe(503);
  });

  it('500s cleanly and logs when the transaction throws', async () => {
    mockState.profileCreate.mockRejectedValue(new Error('db down'));
    const res = await PATCH(makeRequest(VALID_BODY));
    expect(res.status).toBe(500);
    expect(mockState.logError).toHaveBeenCalled();
  });
});
