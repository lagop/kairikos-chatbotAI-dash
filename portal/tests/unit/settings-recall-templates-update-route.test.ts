// =============================================================================
// Unit tests for PATCH /api/admin/portal/settings/recall-templates/[name].
// validateTemplateBody is NOT mocked — it's pure logic, and exercising the
// real function here also covers the route's integration with it.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  requireTotpStepUp: vi.fn(),
  isDatabaseConfigured: true,
  findUniqueOperator: vi.fn(),
  recallTemplateDefinitionFindUnique: vi.fn(),
  txUpdate: vi.fn(),
  txAuditCreate: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...a: unknown[]) => mockState.authenticateAdminRequest(...a),
}));

vi.mock('@/lib/operator-totp-stepup', () => ({
  requireTotpStepUp: (...a: unknown[]) => mockState.requireTotpStepUp(...a),
}));

vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

const tx = {
  recallTemplateDefinition: { update: (...a: unknown[]) => mockState.txUpdate(...a) },
  recallTemplateDefinitionAudit: { create: (...a: unknown[]) => mockState.txAuditCreate(...a) },
};

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    operator: { findUnique: (...a: unknown[]) => mockState.findUniqueOperator(...a) },
    recallTemplateDefinition: { findUnique: (...a: unknown[]) => mockState.recallTemplateDefinitionFindUnique(...a) },
    $transaction: (fn: (tx: unknown) => unknown) => fn(tx),
  },
}));

const AUTH_OK = { ok: true, sessionId: 's1', operatorId: 'op_1' };
const STEP_UP_OK = { ok: true, operatorId: 'op_1', sessionId: 's1' };
const EXISTING = { name: 'recall_caller_open', bodyText: 'Hola {{1}}', bodyExamples: ['Aurora'] };

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

function makeParams(name: string) {
  return { params: { name } };
}

beforeEach(() => {
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue(AUTH_OK);
  mockState.requireTotpStepUp.mockReset().mockResolvedValue(STEP_UP_OK);
  mockState.isDatabaseConfigured = true;
  mockState.findUniqueOperator.mockReset().mockResolvedValue({ email: 'lucia@kairikos.com' });
  mockState.recallTemplateDefinitionFindUnique.mockReset().mockResolvedValue(EXISTING);
  mockState.txUpdate.mockReset().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ name: EXISTING.name, ...data, updatedAt: new Date('2026-09-13T00:00:00.000Z') }),
  );
  mockState.txAuditCreate.mockReset().mockResolvedValue({});
  mockState.logError.mockReset();
});

describe('PATCH /api/admin/portal/settings/recall-templates/[name]', () => {
  const VALID_BODY = { bodyText: 'Hola {{1}}, hoy {{2}}', bodyExamples: ['Aurora', 'mañana'] };

  it('401s without a session', async () => {
    mockState.authenticateAdminRequest.mockResolvedValue({ ok: false });
    const { PATCH } = await import('@/app/api/admin/portal/settings/recall-templates/[name]/route');
    const res = await PATCH(makeRequest(VALID_BODY), makeParams('recall_caller_open'));
    expect(res.status).toBe(401);
    expect(mockState.txUpdate).not.toHaveBeenCalled();
  });

  it('503s when the database is not configured', async () => {
    mockState.isDatabaseConfigured = false;
    const { PATCH } = await import('@/app/api/admin/portal/settings/recall-templates/[name]/route');
    const res = await PATCH(makeRequest(VALID_BODY), makeParams('recall_caller_open'));
    expect(res.status).toBe(503);
  });

  it('403s without TOTP step-up — never even validates the body or touches the DB', async () => {
    mockState.requireTotpStepUp.mockResolvedValue({ ok: false, status: 403, error: 'totp_step_up_required' });
    const { PATCH } = await import('@/app/api/admin/portal/settings/recall-templates/[name]/route');
    const res = await PATCH(makeRequest(VALID_BODY), makeParams('recall_caller_open'));
    expect(res.status).toBe(403);
    expect(mockState.recallTemplateDefinitionFindUnique).not.toHaveBeenCalled();
    expect(mockState.txUpdate).not.toHaveBeenCalled();
  });

  it('400s when the body text is empty', async () => {
    const { PATCH } = await import('@/app/api/admin/portal/settings/recall-templates/[name]/route');
    const res = await PATCH(makeRequest({ bodyText: '', bodyExamples: [] }), makeParams('recall_caller_open'));
    expect(res.status).toBe(400);
    expect(mockState.txUpdate).not.toHaveBeenCalled();
  });

  it('400s when the placeholder count does not match the example count — the exact mistake this route exists to catch', async () => {
    const { PATCH } = await import('@/app/api/admin/portal/settings/recall-templates/[name]/route');
    const res = await PATCH(
      makeRequest({ bodyText: 'Hola {{1}}, hoy {{2}}', bodyExamples: ['Aurora'] }),
      makeParams('recall_caller_open'),
    );
    expect(res.status).toBe(400);
    const body = await res.clone().json();
    expect(body.error).toBe('invalid_placeholders');
    expect(body.detail).toBeTruthy();
    expect(mockState.txUpdate).not.toHaveBeenCalled();
  });

  it('400s on a numbering gap ({{1}}, {{3}} with no {{2}})', async () => {
    const { PATCH } = await import('@/app/api/admin/portal/settings/recall-templates/[name]/route');
    const res = await PATCH(
      makeRequest({ bodyText: 'Hola {{1}}, hoy {{3}}', bodyExamples: ['a', 'b'] }),
      makeParams('recall_caller_open'),
    );
    expect(res.status).toBe(400);
    expect(mockState.txUpdate).not.toHaveBeenCalled();
  });

  it('404s when the template name does not exist', async () => {
    mockState.recallTemplateDefinitionFindUnique.mockResolvedValue(null);
    const { PATCH } = await import('@/app/api/admin/portal/settings/recall-templates/[name]/route');
    const res = await PATCH(makeRequest(VALID_BODY), makeParams('does_not_exist'));
    expect(res.status).toBe(404);
  });

  it('saves on the happy path and audits before/after with the resolved operator email', async () => {
    const { PATCH } = await import('@/app/api/admin/portal/settings/recall-templates/[name]/route');
    const res = await PATCH(makeRequest(VALID_BODY), makeParams('recall_caller_open'));
    expect(res.status).toBe(200);
    const body = await res.clone().json();
    expect(body).toMatchObject({ ok: true, name: 'recall_caller_open', bodyText: VALID_BODY.bodyText, bodyExamples: VALID_BODY.bodyExamples });

    expect(mockState.txUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { name: 'recall_caller_open' },
        data: expect.objectContaining({
          bodyText: VALID_BODY.bodyText,
          bodyExamples: VALID_BODY.bodyExamples,
          updatedByOperatorId: 'op_1',
          updatedByEmail: 'lucia@kairikos.com',
        }),
      }),
    );
    expect(mockState.txAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          templateName: 'recall_caller_open',
          before: { bodyText: EXISTING.bodyText, bodyExamples: EXISTING.bodyExamples },
          after: { bodyText: VALID_BODY.bodyText, bodyExamples: VALID_BODY.bodyExamples },
          actorOperatorId: 'op_1',
          actorEmail: 'lucia@kairikos.com',
        }),
      }),
    );
  });

  it('never touches name/languageCode/category — only bodyText/bodyExamples are accepted in the body schema', async () => {
    const { PATCH } = await import('@/app/api/admin/portal/settings/recall-templates/[name]/route');
    await PATCH(
      makeRequest({ ...VALID_BODY, name: 'renamed', languageCode: 'en', category: 'MARKETING' }),
      makeParams('recall_caller_open'),
    );
    const dataArg = mockState.txUpdate.mock.calls[0][0].data;
    expect(dataArg.name).toBeUndefined();
    expect(dataArg.languageCode).toBeUndefined();
    expect(dataArg.category).toBeUndefined();
  });

  it('500s cleanly, rather than crashing, when persisting throws', async () => {
    mockState.txUpdate.mockRejectedValue(new Error('db down'));
    const { PATCH } = await import('@/app/api/admin/portal/settings/recall-templates/[name]/route');
    const res = await PATCH(makeRequest(VALID_BODY), makeParams('recall_caller_open'));
    expect(res.status).toBe(500);
    expect(await res.clone().json()).toEqual({ error: 'internal_error' });
  });
});
