// =============================================================================
// Unit tests for POST /api/portal/web-quote/request.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  resolveClientFromSession: vi.fn(),
  getSession: vi.fn(),
  findFirstProduct: vi.fn(),
  findUniqueClient: vi.fn(),
  findUniqueClientProduct: vi.fn(),
  clientProductUpsert: vi.fn(),
  clientProductAuditCreate: vi.fn(),
}));

const mockTx = {
  clientProduct: { upsert: (...args: unknown[]) => mockState.clientProductUpsert(...args) },
  clientProductAudit: { create: (...args: unknown[]) => mockState.clientProductAuditCreate(...args) },
};

vi.mock('@/lib/portal-session', () => ({
  resolveClientFromSession: (...args: unknown[]) => mockState.resolveClientFromSession(...args),
}));

vi.mock('@/lib/session', () => ({
  getSession: (...args: unknown[]) => mockState.getSession(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
    product: { findFirst: (...args: unknown[]) => mockState.findFirstProduct(...args) },
    chatbotClient: { findUnique: (...args: unknown[]) => mockState.findUniqueClient(...args) },
    clientProduct: { findUnique: (...args: unknown[]) => mockState.findUniqueClientProduct(...args) },
  },
  isDatabaseConfigured: true,
}));

const RESOLVED = { clientId: 'client_1', email: 'a@b.com', source: 'database' as const };
const WEB_PRODUCT = { id: 'prod_web_1', code: 'web', isActive: true };

beforeEach(() => {
  mockState.resolveClientFromSession.mockReset().mockResolvedValue(RESOLVED);
  mockState.getSession.mockReset().mockResolvedValue({ hasClientAccess: true });
  mockState.findFirstProduct.mockReset().mockResolvedValue(WEB_PRODUCT);
  mockState.findUniqueClient.mockReset().mockResolvedValue({ id: 'client_1', tenantId: 'tenant_1' });
  mockState.findUniqueClientProduct.mockReset().mockResolvedValue(null);
  mockState.clientProductUpsert.mockReset().mockResolvedValue({ id: 'cp_1' });
  mockState.clientProductAuditCreate.mockReset().mockResolvedValue({});
});

async function callRoute() {
  const { POST } = await import('@/app/api/portal/web-quote/request/route');
  return POST();
}

describe('POST /api/portal/web-quote/request', () => {
  it('401s without a session', async () => {
    mockState.resolveClientFromSession.mockResolvedValueOnce(null);
    const res = await callRoute();
    expect(res.status).toBe(401);
    expect(mockState.clientProductUpsert).not.toHaveBeenCalled();
  });

  it('503s outside real-database mode', async () => {
    mockState.resolveClientFromSession.mockResolvedValueOnce({ ...RESOLVED, source: 'mock_dev' });
    const res = await callRoute();
    expect(res.status).toBe(503);
  });

  it('404s when no active web Product exists', async () => {
    mockState.findFirstProduct.mockResolvedValueOnce(null);
    const res = await callRoute();
    expect(res.status).toBe(404);
    const body = await res.clone().json();
    expect(body.error).toBe('product_not_found');
  });

  it('409s already_requested when the client already has a non-cancelled web ClientProduct', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce({ status: 'active' });
    const res = await callRoute();
    expect(res.status).toBe(409);
    const body = await res.clone().json();
    expect(body.error).toBe('already_requested');
    expect(mockState.clientProductUpsert).not.toHaveBeenCalled();
  });

  it('creates the ClientProduct in quote_pending on the happy path (no prior row)', async () => {
    const res = await callRoute();
    expect(res.status).toBe(200);
    const body = await res.clone().json();
    expect(body).toEqual({ status: 'quote_pending' });
    expect(mockState.clientProductUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: 'quote_pending' }),
        update: expect.objectContaining({ status: 'quote_pending', cancelledAt: null }),
      }),
    );
  });

  it('allows re-requesting when the prior row was cancelled', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce({ status: 'cancelled' });
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(mockState.clientProductUpsert).toHaveBeenCalled();
  });
});
