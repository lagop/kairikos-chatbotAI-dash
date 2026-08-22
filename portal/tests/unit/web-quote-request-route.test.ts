// =============================================================================
// Unit tests for POST /api/portal/web-quote/request.
//
// WP-XX — a client can have multiple 'web' projects (see ClientProduct's
// schema comment): the route no longer blocks on "any non-cancelled row"
// (that would prevent a 2nd project while the 1st is simply 'active'),
// only on an in-flight 'quote_pending' negotiation, and it always creates
// a fresh row rather than reactivating an old cancelled one.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  resolveClientFromSession: vi.fn(),
  getSession: vi.fn(),
  findFirstProduct: vi.fn(),
  findUniqueClient: vi.fn(),
  findFirstClientProduct: vi.fn(),
  clientProductCreate: vi.fn(),
  clientProductUpdate: vi.fn(),
  clientProductAuditCreate: vi.fn(),
}));

const mockTx = {
  clientProduct: {
    create: (...args: unknown[]) => mockState.clientProductCreate(...args),
    update: (...args: unknown[]) => mockState.clientProductUpdate(...args),
  },
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
    clientProduct: { findFirst: (...args: unknown[]) => mockState.findFirstClientProduct(...args) },
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
  // Represents "no in-flight quote_pending row" — the route's own query
  // already filters status: 'quote_pending', so a null here means the
  // in-flight check found nothing, regardless of any OTHER (active/
  // cancelled) row that might exist for this client.
  mockState.findFirstClientProduct.mockReset().mockResolvedValue(null);
  mockState.clientProductCreate.mockReset().mockResolvedValue({ id: 'cp_new' });
  mockState.clientProductUpdate.mockReset().mockResolvedValue({ id: 'cp_1' });
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
    expect(mockState.clientProductCreate).not.toHaveBeenCalled();
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

  it('409s already_requested when a quote_pending row is already in flight', async () => {
    mockState.findFirstClientProduct.mockResolvedValueOnce({ id: 'cp_pending' });
    const res = await callRoute();
    expect(res.status).toBe(409);
    const body = await res.clone().json();
    expect(body.error).toBe('already_requested');
    expect(mockState.clientProductCreate).not.toHaveBeenCalled();
  });

  it('creates a new ClientProduct in quote_pending and returns its id (no prior row)', async () => {
    const res = await callRoute();
    expect(res.status).toBe(200);
    const body = await res.clone().json();
    expect(body).toEqual({ status: 'quote_pending', clientProductId: 'cp_new' });
    expect(mockState.clientProductCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ clientId: 'client_1', productId: 'prod_web_1', status: 'quote_pending' }),
      }),
    );
    expect(mockState.clientProductAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ clientProductId: 'cp_new', action: 'web_quote_requested', statusBefore: null }),
    });
  });

  it('always creates a fresh row, never reactivating an old cancelled one — no in-flight row means it just creates', async () => {
    // Even if the client has a prior 'cancelled' web project elsewhere,
    // the in-flight check (status: 'quote_pending') doesn't see it, so a
    // brand-new request creates a brand-new row rather than touching it.
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(mockState.clientProductCreate).toHaveBeenCalledTimes(1);
    expect(mockState.clientProductUpdate).not.toHaveBeenCalled();
  });
});
