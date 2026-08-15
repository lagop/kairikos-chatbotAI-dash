// =============================================================================
// Unit tests for POST /api/portal/web-quote/accept.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  resolveClientFromSession: vi.fn(),
  resolveWebQuoteContext: vi.fn(),
  webQuoteUpdate: vi.fn(),
  webQuoteAuditCreate: vi.fn(),
}));

const mockTx = {
  webQuote: { update: (...args: unknown[]) => mockState.webQuoteUpdate(...args) },
  webQuoteAudit: { create: (...args: unknown[]) => mockState.webQuoteAuditCreate(...args) },
};

vi.mock('@/lib/portal-session', () => ({
  resolveClientFromSession: (...args: unknown[]) => mockState.resolveClientFromSession(...args),
}));

vi.mock('@/lib/web-quotes', () => ({
  resolveWebQuoteContext: (...args: unknown[]) => mockState.resolveWebQuoteContext(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { $transaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx) },
  isDatabaseConfigured: true,
}));

const RESOLVED = { clientId: 'client_1', email: 'a@b.com', source: 'database' as const };

beforeEach(() => {
  mockState.resolveClientFromSession.mockReset().mockResolvedValue(RESOLVED);
  mockState.resolveWebQuoteContext.mockReset();
  mockState.webQuoteUpdate.mockReset().mockResolvedValue({ id: 'wq_1', status: 'accepted' });
  mockState.webQuoteAuditCreate.mockReset().mockResolvedValue({});
});

async function callRoute() {
  const { POST } = await import('@/app/api/portal/web-quote/accept/route');
  return POST();
}

describe('POST /api/portal/web-quote/accept', () => {
  it('401s without a session', async () => {
    mockState.resolveClientFromSession.mockResolvedValueOnce(null);
    const res = await callRoute();
    expect(res.status).toBe(401);
  });

  it('503s outside real-database mode', async () => {
    mockState.resolveClientFromSession.mockResolvedValueOnce({ ...RESOLVED, source: 'mock_dev' });
    const res = await callRoute();
    expect(res.status).toBe(503);
  });

  it('404s when there is no WebQuote for this client', async () => {
    mockState.resolveWebQuoteContext.mockResolvedValueOnce(null);
    const res = await callRoute();
    expect(res.status).toBe(404);
  });

  it('409s not_sent when the quote is not currently sent', async () => {
    mockState.resolveWebQuoteContext.mockResolvedValueOnce({
      clientProduct: { id: 'cp_1', clientId: 'client_1', tenantId: 't1', status: 'quote_pending' },
      webQuote: { id: 'wq_1', status: 'draft' },
    });
    const res = await callRoute();
    expect(res.status).toBe(409);
    const body = await res.clone().json();
    expect(body.error).toBe('not_sent');
    expect(mockState.webQuoteUpdate).not.toHaveBeenCalled();
  });

  it('accepts a sent quote on the happy path', async () => {
    mockState.resolveWebQuoteContext.mockResolvedValueOnce({
      clientProduct: { id: 'cp_1', clientId: 'client_1', tenantId: 't1', status: 'quote_pending' },
      webQuote: { id: 'wq_1', status: 'sent' },
    });
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(mockState.webQuoteUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'wq_1' }, data: expect.objectContaining({ status: 'accepted' }) }),
    );
    expect(mockState.webQuoteAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'accepted', actorType: 'client' }) }),
    );
  });
});
