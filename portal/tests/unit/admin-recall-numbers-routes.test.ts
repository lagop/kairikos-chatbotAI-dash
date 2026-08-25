// =============================================================================
// WP-XX — unit tests for the operator-facing virtual-number routes:
//   GET/POST /api/admin/portal/recall/numbers
//   POST     /api/admin/portal/recall/numbers/assign
//   POST     /api/admin/portal/recall/numbers/[id]/release
//
// The pool logic itself is covered in recall-numbers.test.ts against the
// in-memory provider; this file covers the HTTP layer — auth, validation,
// status-code mapping, and the audit writes.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  isTelephonyConfigured: vi.fn(),
  provisionIntoPool: vi.fn(),
  assignNumberToSubscription: vi.fn(),
  releaseNumber: vi.fn(),
  getPoolSummary: vi.fn(),
  virtualNumberFindMany: vi.fn(),
  virtualNumberFindUnique: vi.fn(),
  recallSubscriptionFindUnique: vi.fn(),
  recallSubscriptionAuditCreate: vi.fn(),
}));

vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...a: unknown[]) => mockState.authenticateAdminRequest(...a),
}));

vi.mock('@/lib/telephony', () => ({
  isTelephonyConfigured: () => mockState.isTelephonyConfigured(),
  getTelephonyProvider: () => ({ name: 'fake' }),
}));

vi.mock('@/lib/recall-numbers', () => ({
  provisionIntoPool: (...a: unknown[]) => mockState.provisionIntoPool(...a),
  assignNumberToSubscription: (...a: unknown[]) => mockState.assignNumberToSubscription(...a),
  releaseNumber: (...a: unknown[]) => mockState.releaseNumber(...a),
  getPoolSummary: (...a: unknown[]) => mockState.getPoolSummary(...a),
}));

vi.mock('@/lib/prisma', () => ({
  isDatabaseConfigured: true,
  prisma: {
    virtualNumber: {
      findMany: (...a: unknown[]) => mockState.virtualNumberFindMany(...a),
      findUnique: (...a: unknown[]) => mockState.virtualNumberFindUnique(...a),
    },
    recallSubscription: {
      findUnique: (...a: unknown[]) => mockState.recallSubscriptionFindUnique(...a),
    },
    recallSubscriptionAudit: {
      create: (...a: unknown[]) => mockState.recallSubscriptionAuditCreate(...a),
    },
  },
}));

const AUTH_OK = { ok: true, sessionId: 's1', operatorId: 'op_1' };
const SUB_ID = '11111111-1111-1111-1111-111111111111';

function makeRequest(body?: unknown) {
  return { json: async () => body ?? null } as unknown as NextRequest;
}

beforeEach(() => {
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue(AUTH_OK);
  mockState.isTelephonyConfigured.mockReset().mockReturnValue(true);
  mockState.provisionIntoPool.mockReset();
  mockState.assignNumberToSubscription.mockReset();
  mockState.releaseNumber.mockReset();
  mockState.getPoolSummary.mockReset().mockResolvedValue({ available: 3, assigned: 1, released: 0 });
  mockState.virtualNumberFindMany.mockReset().mockResolvedValue([]);
  mockState.virtualNumberFindUnique.mockReset().mockResolvedValue(null);
  mockState.recallSubscriptionFindUnique.mockReset().mockResolvedValue({ clientId: 'client_1', status: 'meta_connected' });
  mockState.recallSubscriptionAuditCreate.mockReset().mockResolvedValue({});
});

describe('GET /api/admin/portal/recall/numbers', () => {
  it('401s without an operator session', async () => {
    mockState.authenticateAdminRequest.mockResolvedValueOnce({ ok: false });
    const { GET } = await import('@/app/api/admin/portal/recall/numbers/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns the pool plus a summary', async () => {
    const { GET } = await import('@/app/api/admin/portal/recall/numbers/route');
    const res = await GET(makeRequest());
    const body = await res.clone().json();
    expect(res.status).toBe(200);
    expect(body.summary).toEqual({ available: 3, assigned: 1, released: 0 });
  });
});

describe('POST /api/admin/portal/recall/numbers (provision)', () => {
  async function callRoute(body: unknown) {
    const { POST } = await import('@/app/api/admin/portal/recall/numbers/route');
    return POST(makeRequest(body));
  }

  it('401s without an operator session', async () => {
    mockState.authenticateAdminRequest.mockResolvedValueOnce({ ok: false });
    const res = await callRoute({ count: 1 });
    expect(res.status).toBe(401);
    expect(mockState.provisionIntoPool).not.toHaveBeenCalled();
  });

  it('503s when telephony is not configured, rather than failing mid-purchase', async () => {
    mockState.isTelephonyConfigured.mockReturnValueOnce(false);
    const res = await callRoute({ count: 1 });
    expect(res.status).toBe(503);
    expect(mockState.provisionIntoPool).not.toHaveBeenCalled();
  });

  it('caps the batch size — this endpoint spends money on every call', async () => {
    const res = await callRoute({ count: 100 });
    expect(res.status).toBe(400);
    expect(mockState.provisionIntoPool).not.toHaveBeenCalled();
  });

  it('rejects a zero or negative count', async () => {
    expect((await callRoute({ count: 0 })).status).toBe(400);
    expect((await callRoute({ count: -3 })).status).toBe(400);
  });

  it('defaults the country to ES', async () => {
    mockState.provisionIntoPool.mockResolvedValue({ provisioned: [], failed: [] });
    await callRoute({ count: 1 });
    expect(mockState.provisionIntoPool).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ countryCode: 'ES', count: 1 }),
    );
  });

  it('200s on PARTIAL failure and reports both lists — the bought ones are already billed', async () => {
    mockState.provisionIntoPool.mockResolvedValue({
      provisioned: [{ id: 'vn_1', e164: '+34910000001', providerSid: 'PN1' }],
      failed: [{ e164: '+34910000002', error: '21422: number is not available' }],
    });
    const res = await callRoute({ count: 2 });
    const body = await res.clone().json();

    expect(res.status).toBe(200);
    expect(body.provisioned).toHaveLength(1);
    expect(body.failed).toHaveLength(1);
  });

  it('502s when the provider search itself fails and nothing was bought', async () => {
    mockState.provisionIntoPool.mockResolvedValue({ error: 'twilio_unreachable' });
    const res = await callRoute({ count: 2 });
    expect(res.status).toBe(502);
    expect((await res.clone().json()).detail).toBe('twilio_unreachable');
  });
});

describe('POST /api/admin/portal/recall/numbers/assign', () => {
  async function callRoute(body: unknown) {
    const { POST } = await import('@/app/api/admin/portal/recall/numbers/assign/route');
    return POST(makeRequest(body));
  }

  it('401s without an operator session', async () => {
    mockState.authenticateAdminRequest.mockResolvedValueOnce({ ok: false });
    const res = await callRoute({ subscriptionId: SUB_ID });
    expect(res.status).toBe(401);
  });

  it('400s when subscriptionId is missing or not a uuid', async () => {
    expect((await callRoute({})).status).toBe(400);
    expect((await callRoute({ subscriptionId: 'nope' })).status).toBe(400);
  });

  it.each([
    ['subscription_not_found', 404],
    ['invalid_status', 409],
    ['already_assigned', 409],
    // Not a client error: someone needs to buy more numbers.
    ['pool_empty', 503],
  ])('maps %s to HTTP %i', async (error, status) => {
    mockState.assignNumberToSubscription.mockResolvedValue({ ok: false, error });
    const res = await callRoute({ subscriptionId: SUB_ID });
    expect(res.status).toBe(status);
    expect(mockState.recallSubscriptionAuditCreate).not.toHaveBeenCalled();
  });

  it('assigns and writes an audit row naming the operator', async () => {
    mockState.assignNumberToSubscription.mockResolvedValue({ ok: true, numberId: 'vn_1', e164: '+34910000001' });
    const res = await callRoute({ subscriptionId: SUB_ID });

    expect(res.status).toBe(200);
    expect(await res.clone().json()).toEqual({ ok: true, numberId: 'vn_1', e164: '+34910000001' });
    expect(mockState.recallSubscriptionAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        subscriptionId: SUB_ID,
        clientId: 'client_1',
        action: 'number_assigned',
        actorType: 'operator',
        actorOperatorId: 'op_1',
        after: { virtualNumberId: 'vn_1', e164: '+34910000001' },
      }),
    });
  });

  it('still succeeds when the audit insert fails — the number IS assigned by then', async () => {
    mockState.assignNumberToSubscription.mockResolvedValue({ ok: true, numberId: 'vn_1', e164: '+34910000001' });
    mockState.recallSubscriptionAuditCreate.mockRejectedValue(new Error('db down'));

    const res = await callRoute({ subscriptionId: SUB_ID });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/admin/portal/recall/numbers/[id]/release', () => {
  async function callRoute(id = 'vn_1') {
    const { POST } = await import('@/app/api/admin/portal/recall/numbers/[id]/release/route');
    return POST(makeRequest(), { params: { id } });
  }

  it('401s without an operator session', async () => {
    mockState.authenticateAdminRequest.mockResolvedValueOnce({ ok: false });
    const res = await callRoute();
    expect(res.status).toBe(401);
    expect(mockState.releaseNumber).not.toHaveBeenCalled();
  });

  it.each([
    ['number_not_found', 404],
    ['already_released', 409],
    ['provider_failed', 502],
  ])('maps %s to HTTP %i', async (error, status) => {
    mockState.releaseNumber.mockResolvedValue({ ok: false, error });
    const res = await callRoute();
    expect(res.status).toBe(status);
  });

  it('audits the release against the client who held the number', async () => {
    mockState.virtualNumberFindUnique.mockResolvedValue({
      e164: '+34910000001',
      subscriptionId: SUB_ID,
      subscription: { clientId: 'client_1' },
    });
    mockState.releaseNumber.mockResolvedValue({ ok: true });

    const res = await callRoute();

    expect(res.status).toBe(200);
    expect(mockState.recallSubscriptionAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'number_released',
        clientId: 'client_1',
        before: { virtualNumberId: 'vn_1', e164: '+34910000001' },
      }),
    });
  });

  it('does not audit when the number was sitting unassigned in the pool', async () => {
    mockState.virtualNumberFindUnique.mockResolvedValue({ e164: '+34910000001', subscriptionId: null, subscription: null });
    mockState.releaseNumber.mockResolvedValue({ ok: true });

    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(mockState.recallSubscriptionAuditCreate).not.toHaveBeenCalled();
  });
});
