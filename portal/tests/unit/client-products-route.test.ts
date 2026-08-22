// =============================================================================
// WP-12 — unit tests for POST /api/admin/portal/client-products.
//
// AC: "ClientProduct puede tener varias filas por cliente con productId de
// productos distintos." This is that test — it proves the route's own
// find-then-create-or-update logic never collapses two DIFFERENT products
// for the same client into one row, and that re-posting the SAME (client,
// product) pair is the idempotent no-op the (formerly DB-level, now
// partial-index-level for non-'web' codes) uniqueness is meant to give.
//
// WP-XX — the route no longer does a findUnique-by-compound-key + upsert
// (the (clientId, productId) DB constraint became partial, exempting
// 'web' — see prisma/migrations/20260901120000_client_product_web_multiplicity).
// It's now a findFirst (outside the transaction) followed by an explicit
// create/update branch (inside it).
//
// WP-18 — the route wraps the ClientProduct write and its
// ClientProductAudit row in a single `$transaction`, so the mock exposes a
// `tx` with both tables; `$transaction` just invokes the callback with it
// (matching the mockTx pattern already used elsewhere in this test suite,
// e.g. onboarding-actions.test.ts).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  findUniqueClient: vi.fn(),
  findUniqueProduct: vi.fn(),
  findFirstClientProduct: vi.fn(),
  createClientProduct: vi.fn(),
  updateClientProduct: vi.fn(),
  createClientProductAudit: vi.fn(),
}));

const mockTx = {
  clientProduct: {
    create: (...args: unknown[]) => mockState.createClientProduct(...args),
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
    chatbotClient: {
      findUnique: (...args: unknown[]) => mockState.findUniqueClient(...args),
    },
    product: {
      findUnique: (...args: unknown[]) => mockState.findUniqueProduct(...args),
    },
    clientProduct: {
      findFirst: (...args: unknown[]) => mockState.findFirstClientProduct(...args),
    },
  },
  isDatabaseConfigured: true,
}));

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<
    typeof import('@/app/api/admin/portal/client-products/route').POST
  >[0];
}

beforeEach(() => {
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue({ ok: true, operatorId: 'op_1' });
  mockState.findUniqueClient.mockReset().mockResolvedValue({ id: 'client_1', tenantId: 'tenant_1' });
  mockState.findUniqueProduct.mockReset().mockResolvedValue({ id: 'prod_1', isActive: true });
  mockState.findFirstClientProduct.mockReset().mockResolvedValue(null);
  mockState.createClientProduct.mockReset();
  mockState.updateClientProduct.mockReset();
  mockState.createClientProductAudit.mockReset();
});

describe('POST /api/admin/portal/client-products — multi-product assignment', () => {
  it('assigning two different products to the same client issues two distinct creates, each looked up by (clientId, productId)', async () => {
    const { POST } = await import('@/app/api/admin/portal/client-products/route');

    mockState.findUniqueProduct.mockResolvedValueOnce({ id: '11111111-1111-1111-1111-111111111111', isActive: true });
    mockState.createClientProduct.mockResolvedValueOnce({ id: 'cp_1', clientId: 'client_1', productId: '11111111-1111-1111-1111-111111111111' });
    const res1 = await POST(makeRequest({ clientId: 'client_1', productId: '11111111-1111-1111-1111-111111111111' }));
    expect(res1.status).toBe(201);

    mockState.findUniqueProduct.mockResolvedValueOnce({ id: '22222222-2222-2222-2222-222222222222', isActive: true });
    mockState.createClientProduct.mockResolvedValueOnce({ id: 'cp_2', clientId: 'client_1', productId: '22222222-2222-2222-2222-222222222222' });
    const res2 = await POST(makeRequest({ clientId: 'client_1', productId: '22222222-2222-2222-2222-222222222222' }));
    expect(res2.status).toBe(201);

    expect(mockState.createClientProduct).toHaveBeenCalledTimes(2);
    expect(mockState.findFirstClientProduct).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: { clientId: 'client_1', productId: '11111111-1111-1111-1111-111111111111' } }),
    );
    expect(mockState.findFirstClientProduct).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: { clientId: 'client_1', productId: '22222222-2222-2222-2222-222222222222' } }),
    );
  });

  it('re-posting the same (clientId, productId) pair takes the idempotent update branch, not a duplicate create', async () => {
    const { POST } = await import('@/app/api/admin/portal/client-products/route');

    mockState.createClientProduct.mockResolvedValueOnce({ id: 'cp_1', clientId: 'client_1', productId: '11111111-1111-1111-1111-111111111111' });
    await POST(makeRequest({ clientId: 'client_1', productId: '11111111-1111-1111-1111-111111111111' }));

    mockState.findFirstClientProduct.mockResolvedValueOnce({ id: 'cp_1', status: 'active' });
    mockState.updateClientProduct.mockResolvedValueOnce({ id: 'cp_1', clientId: 'client_1', productId: '11111111-1111-1111-1111-111111111111' });
    await POST(makeRequest({ clientId: 'client_1', productId: '11111111-1111-1111-1111-111111111111' }));

    expect(mockState.createClientProduct).toHaveBeenCalledTimes(1);
    expect(mockState.updateClientProduct).toHaveBeenCalledTimes(1);
    expect(mockState.updateClientProduct).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cp_1' } }),
    );
  });

  it('refuses to assign an inactive product', async () => {
    mockState.findUniqueProduct.mockResolvedValueOnce({ id: 'prod_resenas', isActive: false });

    const { POST } = await import('@/app/api/admin/portal/client-products/route');
    const res = await POST(
      makeRequest({ clientId: 'client_1', productId: '33333333-3333-3333-3333-333333333333' }),
    );

    expect(res.status).toBe(404);
    expect(mockState.createClientProduct).not.toHaveBeenCalled();
    expect(mockState.updateClientProduct).not.toHaveBeenCalled();
    expect(mockState.createClientProductAudit).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/portal/client-products — WP-18 audit trail', () => {
  it('writes a ClientProductAudit row with action=assign for a brand-new (clientId, productId)', async () => {
    mockState.findFirstClientProduct.mockResolvedValueOnce(null);
    mockState.createClientProduct.mockResolvedValueOnce({
      id: 'cp_1',
      clientId: 'client_1',
      productId: '11111111-1111-1111-1111-111111111111',
    });

    const { POST } = await import('@/app/api/admin/portal/client-products/route');
    const res = await POST(
      makeRequest({ clientId: 'client_1', productId: '11111111-1111-1111-1111-111111111111' }),
    );

    expect(res.status).toBe(201);
    expect(mockState.createClientProductAudit).toHaveBeenCalledTimes(1);
    expect(mockState.createClientProductAudit).toHaveBeenCalledWith({
      data: expect.objectContaining({
        clientProductId: 'cp_1',
        clientId: 'client_1',
        productId: '11111111-1111-1111-1111-111111111111',
        tenantId: 'tenant_1',
        action: 'assign',
        statusBefore: null,
        statusAfter: 'active',
        actorId: 'op_1',
      }),
    });
  });

  it('writes action=reactivate (with the prior status) when the row already existed', async () => {
    mockState.findFirstClientProduct.mockResolvedValueOnce({ id: 'cp_1', status: 'cancelled' });
    mockState.updateClientProduct.mockResolvedValueOnce({
      id: 'cp_1',
      clientId: 'client_1',
      productId: '11111111-1111-1111-1111-111111111111',
    });

    const { POST } = await import('@/app/api/admin/portal/client-products/route');
    await POST(makeRequest({ clientId: 'client_1', productId: '11111111-1111-1111-1111-111111111111' }));

    expect(mockState.createClientProductAudit).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'reactivate', statusBefore: 'cancelled', statusAfter: 'active' }),
    });
  });
});
