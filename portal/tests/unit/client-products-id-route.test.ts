// =============================================================================
// WP-18 — unit tests for PATCH /api/admin/portal/client-products/[id].
//
// The route wraps the ClientProduct status update and its
// ClientProductAudit row in a single `$transaction` (see
// api/admin/portal/client-products/route.ts for the sibling POST/assign
// tests using the same mockTx pattern). These tests prove: (a) retiring a
// product (status='cancelled') writes action='retire' and stamps
// cancelledAt; (b) any other status change writes action='status_change'
// and clears cancelledAt; (c) the audit row always carries the prior
// status as statusBefore.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  findUniqueClientProduct: vi.fn(),
  updateClientProduct: vi.fn(),
  createClientProductAudit: vi.fn(),
}));

const mockTx = {
  clientProduct: {
    update: (...args: unknown[]) => mockState.updateClientProduct(...args),
  },
  clientProductAudit: {
    create: (...args: unknown[]) => mockState.createClientProductAudit(...args),
  },
};

vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...args: unknown[]) => mockState.authenticateAdminRequest(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
    clientProduct: {
      findUnique: (...args: unknown[]) => mockState.findUniqueClientProduct(...args),
    },
  },
  isDatabaseConfigured: true,
}));

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<
    typeof import('@/app/api/admin/portal/client-products/[id]/route').PATCH
  >[0];
}

beforeEach(() => {
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue({ ok: true, operatorId: 'op_1' });
  mockState.findUniqueClientProduct.mockReset().mockResolvedValue({
    id: '11111111-1111-1111-1111-111111111111',
    clientId: 'client_1',
    productId: 'prod_1',
    tenantId: 'tenant_1',
    status: 'active',
  });
  mockState.updateClientProduct.mockReset();
  mockState.createClientProductAudit.mockReset();
});

describe('PATCH /api/admin/portal/client-products/[id]', () => {
  it('retiring a product (status=cancelled) writes action=retire and stamps cancelledAt', async () => {
    mockState.updateClientProduct.mockResolvedValueOnce({
      id: '11111111-1111-1111-1111-111111111111',
      clientId: 'client_1',
      productId: 'prod_1',
      tenantId: 'tenant_1',
      status: 'cancelled',
    });

    const { PATCH } = await import('@/app/api/admin/portal/client-products/[id]/route');
    const res = await PATCH(makeRequest({ status: 'cancelled' }), { params: { id: '11111111-1111-1111-1111-111111111111' } });

    expect(res.status).toBe(200);
    expect(mockState.updateClientProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: '11111111-1111-1111-1111-111111111111' },
        data: expect.objectContaining({ status: 'cancelled', cancelledAt: expect.any(Date), changedBy: 'op_1' }),
      }),
    );
    expect(mockState.createClientProductAudit).toHaveBeenCalledWith({
      data: expect.objectContaining({
        clientProductId: '11111111-1111-1111-1111-111111111111',
        clientId: 'client_1',
        productId: 'prod_1',
        tenantId: 'tenant_1',
        action: 'retire',
        statusBefore: 'active',
        statusAfter: 'cancelled',
        actorId: 'op_1',
      }),
    });
  });

  it('a non-retiring status change writes action=status_change and clears cancelledAt', async () => {
    mockState.updateClientProduct.mockResolvedValueOnce({
      id: '11111111-1111-1111-1111-111111111111',
      clientId: 'client_1',
      productId: 'prod_1',
      tenantId: 'tenant_1',
      status: 'paused',
    });

    const { PATCH } = await import('@/app/api/admin/portal/client-products/[id]/route');
    await PATCH(makeRequest({ status: 'paused' }), { params: { id: '11111111-1111-1111-1111-111111111111' } });

    expect(mockState.updateClientProduct).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'paused', cancelledAt: null }) }),
    );
    expect(mockState.createClientProductAudit).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'status_change', statusBefore: 'active', statusAfter: 'paused' }),
    });
  });

  it('404s and writes no audit row when the ClientProduct does not exist', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce(null);

    const { PATCH } = await import('@/app/api/admin/portal/client-products/[id]/route');
    const res = await PATCH(makeRequest({ status: 'cancelled' }), {
      params: { id: '22222222-2222-2222-2222-222222222222' },
    });

    expect(res.status).toBe(404);
    expect(mockState.updateClientProduct).not.toHaveBeenCalled();
    expect(mockState.createClientProductAudit).not.toHaveBeenCalled();
  });
});
