// =============================================================================
// Unit tests for the non-TOTP WebQuote admin routes:
// POST   .../web-quotes            (create draft)
// PATCH  .../web-quotes/[id]        (edit draft/sent)
// POST   .../web-quotes/[id]/cancel
// POST   .../web-quotes/[id]/reset
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  findFirstClientProduct: vi.fn(),
  findUniqueWebQuote: vi.fn(),
  webQuoteCreate: vi.fn(),
  webQuoteUpdate: vi.fn(),
  webQuoteAuditCreate: vi.fn(),
}));

const mockTx = {
  webQuote: {
    create: (...args: unknown[]) => mockState.webQuoteCreate(...args),
    update: (...args: unknown[]) => mockState.webQuoteUpdate(...args),
  },
  webQuoteAudit: { create: (...args: unknown[]) => mockState.webQuoteAuditCreate(...args) },
};

vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...args: unknown[]) => mockState.authenticateAdminRequest(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
    clientProduct: { findFirst: (...args: unknown[]) => mockState.findFirstClientProduct(...args) },
    webQuote: { findUnique: (...args: unknown[]) => mockState.findUniqueWebQuote(...args) },
  },
  isDatabaseConfigured: true,
}));

const AUTH_OK = { ok: true, sessionId: 's1', operatorId: 'op_1' };

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue(AUTH_OK);
  mockState.findFirstClientProduct.mockReset().mockResolvedValue({ id: 'cp_1', tenantId: 't1', status: 'quote_pending' });
  mockState.findUniqueWebQuote.mockReset();
  mockState.webQuoteCreate.mockReset().mockResolvedValue({ id: 'wq_1', amountCents: 99900, currency: 'eur', description: 'x' });
  mockState.webQuoteUpdate.mockReset().mockResolvedValue({ id: 'wq_1' });
  mockState.webQuoteAuditCreate.mockReset().mockResolvedValue({});
});

describe('POST /api/admin/portal/web-quotes (create draft)', () => {
  async function callRoute(body: unknown) {
    const { POST } = await import('@/app/api/admin/portal/web-quotes/route');
    return POST(makeRequest(body));
  }

  it('401s without a real operator session', async () => {
    mockState.authenticateAdminRequest.mockResolvedValueOnce({ ok: false });
    const res = await callRoute({ clientId: 'c1', amountCents: 99900, description: 'x' });
    expect(res.status).toBe(401);
  });

  it('404s when the client has no web ClientProduct yet', async () => {
    mockState.findFirstClientProduct.mockResolvedValueOnce(null);
    const res = await callRoute({ clientId: 'c1', amountCents: 99900, description: 'x' });
    expect(res.status).toBe(404);
  });

  it('409s not_quote_pending when the ClientProduct is not in the quote flow', async () => {
    mockState.findFirstClientProduct.mockResolvedValueOnce({ id: 'cp_1', tenantId: 't1', status: 'active' });
    const res = await callRoute({ clientId: 'c1', amountCents: 99900, description: 'x' });
    expect(res.status).toBe(409);
    expect((await res.clone().json()).error).toBe('not_quote_pending');
  });

  it('201s and creates the draft on the happy path', async () => {
    const res = await callRoute({ clientId: 'c1', amountCents: 99900, description: 'Sitio web' });
    expect(res.status).toBe(201);
    expect(mockState.webQuoteCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ amountCents: 99900, depositCents: null, description: 'Sitio web', createdByOperatorId: 'op_1' }),
      }),
    );
  });

  it('400s when depositCents is not less than amountCents', async () => {
    const res = await callRoute({ clientId: 'c1', amountCents: 99900, depositCents: 99900, description: 'Sitio web' });
    expect(res.status).toBe(400);
    expect(mockState.webQuoteCreate).not.toHaveBeenCalled();
  });

  it('201s and persists depositCents when provided and valid', async () => {
    const res = await callRoute({ clientId: 'c1', amountCents: 99900, depositCents: 30000, description: 'Sitio web' });
    expect(res.status).toBe(201);
    expect(mockState.webQuoteCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ depositCents: 30000 }) }),
    );
  });
});

describe('PATCH /api/admin/portal/web-quotes/[id] (edit)', () => {
  async function callRoute(body: unknown) {
    const { PATCH } = await import('@/app/api/admin/portal/web-quotes/[id]/route');
    return PATCH(makeRequest(body), { params: { id: 'wq_1' } });
  }

  it('404s when the quote does not exist', async () => {
    mockState.findUniqueWebQuote.mockResolvedValueOnce(null);
    const res = await callRoute({ amountCents: 100 });
    expect(res.status).toBe(404);
  });

  it('409s quote_locked when the quote is already accepted', async () => {
    mockState.findUniqueWebQuote.mockResolvedValueOnce({ id: 'wq_1', status: 'accepted', amountCents: 99900, description: 'x' });
    const res = await callRoute({ amountCents: 100 });
    expect(res.status).toBe(409);
  });

  it('200s and updates the amount on a draft quote', async () => {
    mockState.findUniqueWebQuote.mockResolvedValueOnce({ id: 'wq_1', status: 'draft', amountCents: 99900, depositCents: null, description: 'x' });
    const res = await callRoute({ amountCents: 120000 });
    expect(res.status).toBe(200);
    expect(mockState.webQuoteUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amountCents: 120000 }) }),
    );
  });

  it('400s when the new depositCents would not be less than the (unchanged) amountCents', async () => {
    mockState.findUniqueWebQuote.mockResolvedValueOnce({ id: 'wq_1', status: 'draft', amountCents: 99900, depositCents: null, description: 'x' });
    const res = await callRoute({ depositCents: 99900 });
    expect(res.status).toBe(400);
    expect(mockState.webQuoteUpdate).not.toHaveBeenCalled();
  });

  it('200s and sets depositCents on a draft quote', async () => {
    mockState.findUniqueWebQuote.mockResolvedValueOnce({ id: 'wq_1', status: 'draft', amountCents: 99900, depositCents: null, description: 'x' });
    const res = await callRoute({ depositCents: 30000 });
    expect(res.status).toBe(200);
    expect(mockState.webQuoteUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ depositCents: 30000 }) }),
    );
  });

  it('200s and clears a previously-set depositCents when passed null', async () => {
    mockState.findUniqueWebQuote.mockResolvedValueOnce({ id: 'wq_1', status: 'draft', amountCents: 99900, depositCents: 30000, description: 'x' });
    const res = await callRoute({ depositCents: null });
    expect(res.status).toBe(200);
    expect(mockState.webQuoteUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ depositCents: null }) }),
    );
  });
});

describe('POST /api/admin/portal/web-quotes/[id]/cancel', () => {
  async function callRoute() {
    const { POST } = await import('@/app/api/admin/portal/web-quotes/[id]/cancel/route');
    return POST({} as NextRequest, { params: { id: 'wq_1' } });
  }

  it('409s cannot_cancel when the quote is already invoiced', async () => {
    mockState.findUniqueWebQuote.mockResolvedValueOnce({ id: 'wq_1', status: 'invoiced' });
    const res = await callRoute();
    expect(res.status).toBe(409);
    expect((await res.clone().json()).error).toBe('cannot_cancel');
  });

  it('200s and cancels a draft quote', async () => {
    mockState.findUniqueWebQuote.mockResolvedValueOnce({ id: 'wq_1', status: 'draft' });
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(mockState.webQuoteUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'cancelled' }) }),
    );
  });
});

describe('POST /api/admin/portal/web-quotes/[id]/reset', () => {
  async function callRoute() {
    const { POST } = await import('@/app/api/admin/portal/web-quotes/[id]/reset/route');
    return POST({} as NextRequest, { params: { id: 'wq_1' } });
  }

  it('409s not_cancelled when the quote is not currently cancelled', async () => {
    mockState.findUniqueWebQuote.mockResolvedValueOnce({ id: 'wq_1', status: 'draft' });
    const res = await callRoute();
    expect(res.status).toBe(409);
  });

  it('200s and resets a cancelled quote back to draft', async () => {
    mockState.findUniqueWebQuote.mockResolvedValueOnce({ id: 'wq_1', status: 'cancelled' });
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(mockState.webQuoteUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'draft' }) }),
    );
  });
});
