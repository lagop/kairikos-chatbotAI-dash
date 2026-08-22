// =============================================================================
// Unit tests for POST /api/portal/web-quote/accept.
//
// WP-XX — clientProductId is now required in the body: a client can have
// multiple 'web' projects (see ClientProduct's schema comment), each with
// its own quote lifecycle, so the route can no longer infer "the" quote
// from the session's clientId alone.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  resolveClientFromSession: vi.fn(),
  getSession: vi.fn(),
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

vi.mock('@/lib/session', () => ({
  getSession: (...args: unknown[]) => mockState.getSession(...args),
}));

vi.mock('@/lib/web-quotes', () => ({
  resolveWebQuoteContext: (...args: unknown[]) => mockState.resolveWebQuoteContext(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { $transaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx) },
  isDatabaseConfigured: true,
}));

const RESOLVED = { clientId: 'client_1', email: 'a@b.com', source: 'database' as const };
const CLIENT_PRODUCT_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  mockState.resolveClientFromSession.mockReset().mockResolvedValue(RESOLVED);
  mockState.getSession.mockReset().mockResolvedValue({ hasClientAccess: true });
  mockState.resolveWebQuoteContext.mockReset();
  mockState.webQuoteUpdate.mockReset().mockResolvedValue({ id: 'wq_1', status: 'accepted' });
  mockState.webQuoteAuditCreate.mockReset().mockResolvedValue({});
});

function makeRequest(body: unknown = { clientProductId: CLIENT_PRODUCT_ID }) {
  return { json: async () => body } as unknown as NextRequest;
}

async function callRoute(body?: unknown) {
  const { POST } = await import('@/app/api/portal/web-quote/accept/route');
  return POST(makeRequest(body));
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

  it('400s when clientProductId is missing or not a uuid', async () => {
    const res = await callRoute({ clientProductId: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });

  it('404s when there is no matching web ClientProduct', async () => {
    mockState.resolveWebQuoteContext.mockResolvedValueOnce(null);
    const res = await callRoute();
    expect(res.status).toBe(404);
  });

  it('404s when the ClientProduct belongs to a different client', async () => {
    mockState.resolveWebQuoteContext.mockResolvedValueOnce({
      clientProduct: { id: CLIENT_PRODUCT_ID, clientId: 'someone_else', tenantId: 't1', status: 'quote_pending' },
      webQuote: { id: 'wq_1', status: 'sent' },
    });
    const res = await callRoute();
    expect(res.status).toBe(404);
    expect(mockState.webQuoteUpdate).not.toHaveBeenCalled();
  });

  it('404s when there is no WebQuote for this project', async () => {
    mockState.resolveWebQuoteContext.mockResolvedValueOnce({
      clientProduct: { id: CLIENT_PRODUCT_ID, clientId: 'client_1', tenantId: 't1', status: 'quote_pending' },
      webQuote: null,
    });
    const res = await callRoute();
    expect(res.status).toBe(404);
  });

  it('409s not_sent when the quote is not currently sent', async () => {
    mockState.resolveWebQuoteContext.mockResolvedValueOnce({
      clientProduct: { id: CLIENT_PRODUCT_ID, clientId: 'client_1', tenantId: 't1', status: 'quote_pending' },
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
      clientProduct: { id: CLIENT_PRODUCT_ID, clientId: 'client_1', tenantId: 't1', status: 'quote_pending' },
      webQuote: { id: 'wq_1', status: 'sent' },
    });
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(mockState.resolveWebQuoteContext).toHaveBeenCalledWith(expect.anything(), CLIENT_PRODUCT_ID);
    expect(mockState.webQuoteUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'wq_1' }, data: expect.objectContaining({ status: 'accepted' }) }),
    );
    expect(mockState.webQuoteAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'accepted', actorType: 'client' }) }),
    );
  });
});
