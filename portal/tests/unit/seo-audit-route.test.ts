// =============================================================================
// SEO con IA, Fase A — unit tests for
// POST /api/admin/portal/seo/[clientId]/audit. Same conventions as
// seo-technical-setup-route.test.ts, including the legacy-auth regression
// coverage.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  authenticateAdminRequest: vi.fn(),
  operatorFindUnique: vi.fn(),
  profileFindFirst: vi.fn(),
  profileUpdate: vi.fn(),
  auditCreate: vi.fn(),
  auditWebsite: vi.fn(),
  logError: vi.fn(),
}));

const mockTx = {
  seoProfile: { update: (...a: unknown[]) => mockState.profileUpdate(...a) },
  seoProfileAudit: { create: (...a: unknown[]) => mockState.auditCreate(...a) },
};

vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...a: unknown[]) => mockState.authenticateAdminRequest(...a),
}));

vi.mock('@/lib/seo-audit', () => ({
  auditWebsite: (...a: unknown[]) => mockState.auditWebsite(...a),
}));

vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    operator: { findUnique: (...a: unknown[]) => mockState.operatorFindUnique(...a) },
    seoProfile: {
      findFirst: (...a: unknown[]) => mockState.profileFindFirst(...a),
      update: (...a: unknown[]) => mockState.profileUpdate(...a),
    },
    $transaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
  },
}));

import { POST } from '@/app/api/admin/portal/seo/[clientId]/audit/route';

function makeRequest() {
  return {} as NextRequest;
}

async function post(clientId: string) {
  return POST(makeRequest(), { params: { clientId } });
}

const PROFILE = { id: 'profile_1', tenantId: 't1', siteUrl: 'https://negocio.example' };
const AUDIT_RESULT = {
  title: 'Negocio',
  metaDescription: 'desc',
  h1Count: 1,
  h1Texts: ['Negocio'],
  imagesTotal: 2,
  imagesMissingAlt: 1,
  linksInternal: 3,
  linksExternal: 1,
  brokenLinksChecked: 3,
  brokenLinks: [{ url: 'https://negocio.example/roto', status: 404 }],
  checkedAt: '2026-09-06T00:00:00.000Z',
};

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue({ ok: true, sessionId: 's1', operatorId: 'op_1' });
  mockState.operatorFindUnique.mockReset().mockResolvedValue({ email: 'op@kairikos.com' });
  mockState.profileFindFirst.mockReset().mockResolvedValue(PROFILE);
  mockState.profileUpdate.mockReset().mockResolvedValue({});
  mockState.auditCreate.mockReset();
  mockState.auditWebsite.mockReset().mockResolvedValue({ ok: true, data: AUDIT_RESULT });
  mockState.logError.mockReset();
});

describe('POST /api/admin/portal/seo/[clientId]/audit', () => {
  it('401s without a valid admin session', async () => {
    mockState.authenticateAdminRequest.mockResolvedValue({ ok: false });
    const res = await post('client_1');
    expect(res.status).toBe(401);
    expect(mockState.auditWebsite).not.toHaveBeenCalled();
  });

  it('404s when the client has no SeoProfile yet', async () => {
    mockState.profileFindFirst.mockResolvedValue(null);
    const res = await post('client_1');
    expect(res.status).toBe(404);
    expect(mockState.auditWebsite).not.toHaveBeenCalled();
  });

  it('400s when the client has not indicated a siteUrl', async () => {
    mockState.profileFindFirst.mockResolvedValue({ ...PROFILE, siteUrl: null });
    const res = await post('client_1');
    expect(res.status).toBe(400);
    expect(mockState.auditWebsite).not.toHaveBeenCalled();
  });

  it('runs the audit against the profile siteUrl and persists the result', async () => {
    const res = await post('client_1');
    expect(res.status).toBe(200);
    expect(mockState.auditWebsite).toHaveBeenCalledWith('https://negocio.example');
    const body = await res.json();
    expect(body).toEqual({ ok: true, result: AUDIT_RESULT });
    expect(mockState.profileUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'profile_1' },
        data: expect.objectContaining({ lastAuditResult: AUDIT_RESULT, lastAuditError: null }),
      }),
    );
    expect(mockState.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'audit_run',
          actorType: 'operator',
          actorOperatorId: 'op_1',
          actorEmail: 'op@kairikos.com',
          after: expect.objectContaining({ h1Count: 1, imagesMissingAlt: 1, brokenLinksFound: 1 }),
        }),
      }),
    );
  });

  it('a failed audit attempt saves lastAuditError and returns 502, without touching a prior lastAuditResult', async () => {
    mockState.auditWebsite.mockResolvedValue({ ok: false, error: 'timeout' });
    const res = await post('client_1');
    expect(res.status).toBe(502);
    expect(mockState.profileUpdate).toHaveBeenCalledWith({ where: { id: 'profile_1' }, data: { lastAuditError: 'timeout' } });
    expect(mockState.auditCreate).not.toHaveBeenCalled();
  });

  it('the legacy KAIA_OPERATOR_API_KEY auth path saves with a null actorOperatorId instead of crashing', async () => {
    mockState.authenticateAdminRequest.mockResolvedValue({ ok: true, sessionId: 'legacy', operatorId: 'legacy' });
    const res = await post('client_1');
    expect(res.status).toBe(200);
    expect(mockState.operatorFindUnique).not.toHaveBeenCalled();
    expect(mockState.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ actorOperatorId: null, actorEmail: null }) }),
    );
  });

  it('503s when the database is not configured', async () => {
    mockState.isDatabaseConfigured = false;
    const res = await post('client_1');
    expect(res.status).toBe(503);
  });

  it('500s cleanly and logs when persisting a successful audit throws', async () => {
    mockState.profileUpdate.mockRejectedValue(new Error('db down'));
    const res = await post('client_1');
    expect(res.status).toBe(500);
    expect(mockState.logError).toHaveBeenCalled();
  });
});
