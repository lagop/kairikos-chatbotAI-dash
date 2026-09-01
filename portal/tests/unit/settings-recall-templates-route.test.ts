// =============================================================================
// Unit tests for GET /api/admin/portal/settings/recall-templates.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  isDatabaseConfigured: true,
  recallTemplateDefinitionFindMany: vi.fn(),
}));

vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...a: unknown[]) => mockState.authenticateAdminRequest(...a),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    recallTemplateDefinition: {
      findMany: (...a: unknown[]) => mockState.recallTemplateDefinitionFindMany(...a),
    },
  },
}));

const ROW = {
  name: 'recall_caller_open',
  languageCode: 'es',
  category: 'UTILITY',
  bodyText: 'Hola {{1}}',
  bodyExamples: ['Aurora'],
  updatedAt: new Date('2026-09-13T00:00:00.000Z'),
  updatedByEmail: null,
};

function makeRequest() {
  return {} as unknown as NextRequest;
}

beforeEach(() => {
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue({ ok: true, sessionId: 's1', operatorId: 'op_1' });
  mockState.isDatabaseConfigured = true;
  mockState.recallTemplateDefinitionFindMany.mockReset().mockResolvedValue([ROW]);
});

describe('GET /api/admin/portal/settings/recall-templates', () => {
  it('401s without a valid admin session', async () => {
    mockState.authenticateAdminRequest.mockResolvedValue({ ok: false });
    const { GET } = await import('@/app/api/admin/portal/settings/recall-templates/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('503s when the database is not configured', async () => {
    mockState.isDatabaseConfigured = false;
    const { GET } = await import('@/app/api/admin/portal/settings/recall-templates/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(503);
  });

  it('returns every definition, ordered by sortOrder, with the full body text (not a secret)', async () => {
    const { GET } = await import('@/app/api/admin/portal/settings/recall-templates/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.templates).toEqual([
      {
        name: 'recall_caller_open',
        languageCode: 'es',
        category: 'UTILITY',
        bodyText: 'Hola {{1}}',
        bodyExamples: ['Aurora'],
        updatedAt: '2026-09-13T00:00:00.000Z',
        updatedByEmail: null,
      },
    ]);
    expect(mockState.recallTemplateDefinitionFindMany).toHaveBeenCalledWith({ orderBy: { sortOrder: 'asc' } });
  });
});
