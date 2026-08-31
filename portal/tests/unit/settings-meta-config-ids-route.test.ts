// =============================================================================
// Unit tests for POST /api/admin/portal/settings/meta/config-ids.
// Mirrors settings-twilio-regulatory-ids-route.test.ts's conventions closely.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  findUniqueOperator: vi.fn(),
  saveMetaConfigIds: vi.fn(),
}));

vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...args: unknown[]) => mockState.authenticateAdminRequest(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    operator: { findUnique: (...args: unknown[]) => mockState.findUniqueOperator(...args) },
  },
  isDatabaseConfigured: true,
}));

vi.mock('@/lib/meta-credentials', () => ({
  saveMetaConfigIds: (...args: unknown[]) => mockState.saveMetaConfigIds(...args),
}));

const AUTH_OK = { ok: true, sessionId: 's1', operatorId: 'op_1' };
const AUTH_LEGACY = { ok: true, sessionId: 'legacy', operatorId: 'legacy' };

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue(AUTH_OK);
  mockState.findUniqueOperator.mockReset().mockResolvedValue({ email: 'lucia@kairikos.com' });
  mockState.saveMetaConfigIds.mockReset().mockResolvedValue(undefined);
});

const VALID_BODY = { configId: 'config_1', coexistenceConfigId: 'coexistence_config_1' };

describe('POST /api/admin/portal/settings/meta/config-ids', () => {
  it('401s without a session', async () => {
    mockState.authenticateAdminRequest.mockResolvedValueOnce({ ok: false });
    const { POST } = await import('@/app/api/admin/portal/settings/meta/config-ids/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(401);
    expect(mockState.saveMetaConfigIds).not.toHaveBeenCalled();
  });

  it('400s when either field is missing', async () => {
    const { POST } = await import('@/app/api/admin/portal/settings/meta/config-ids/route');
    const res = await POST(makeRequest({ configId: 'config_1' }));
    expect(res.status).toBe(400);
    expect(mockState.saveMetaConfigIds).not.toHaveBeenCalled();
  });

  it('never requires TOTP step-up — accepts a plain admin session', async () => {
    const { POST } = await import('@/app/api/admin/portal/settings/meta/config-ids/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(200);
  });

  it('saves on the happy path', async () => {
    const { POST } = await import('@/app/api/admin/portal/settings/meta/config-ids/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(200);
    const body = await res.clone().json();
    expect(body).toEqual({ ok: true, configId: VALID_BODY.configId, coexistenceConfigId: VALID_BODY.coexistenceConfigId });
    expect(mockState.saveMetaConfigIds).toHaveBeenCalledWith(
      VALID_BODY.configId,
      VALID_BODY.coexistenceConfigId,
      { operatorId: 'op_1', operatorEmail: 'lucia@kairikos.com' },
    );
  });

  it('passes operatorId: null for the legacy key path instead of the non-UUID "legacy" sentinel', async () => {
    mockState.authenticateAdminRequest.mockResolvedValueOnce(AUTH_LEGACY);
    const { POST } = await import('@/app/api/admin/portal/settings/meta/config-ids/route');
    await POST(makeRequest(VALID_BODY));

    expect(mockState.findUniqueOperator).not.toHaveBeenCalled();
    expect(mockState.saveMetaConfigIds).toHaveBeenCalledWith(
      VALID_BODY.configId,
      VALID_BODY.coexistenceConfigId,
      { operatorId: null, operatorEmail: null },
    );
  });

  it('500s cleanly, rather than crashing, when persisting throws', async () => {
    mockState.saveMetaConfigIds.mockRejectedValueOnce(new Error('db down'));
    const { POST } = await import('@/app/api/admin/portal/settings/meta/config-ids/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(500);
    expect(await res.clone().json()).toEqual({ error: 'internal_error' });
  });
});
