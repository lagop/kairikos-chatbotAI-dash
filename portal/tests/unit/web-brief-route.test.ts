// =============================================================================
// Unit tests for POST /api/portal/web-brief.
//
// WP-XX — the route is now keyed by clientProductId (one brief per 'web'
// project, not per client — see prisma/schema.prisma's WebBrief comment),
// and every write appends a WebBriefAudit row.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  resolveClientFromSession: vi.fn(),
  getSession: vi.fn(),
  isDatabaseConfigured: true,
  findUniqueClientProduct: vi.fn(),
  webBriefFindUnique: vi.fn(),
  webBriefUpsert: vi.fn(),
  webBriefAuditCreate: vi.fn(),
}));

const mockTx = {
  webBrief: {
    findUnique: (...args: unknown[]) => mockState.webBriefFindUnique(...args),
    upsert: (...args: unknown[]) => mockState.webBriefUpsert(...args),
  },
  webBriefAudit: {
    create: (...args: unknown[]) => mockState.webBriefAuditCreate(...args),
  },
};

vi.mock('@/lib/portal-session', () => ({
  resolveClientFromSession: (...args: unknown[]) => mockState.resolveClientFromSession(...args),
}));

vi.mock('@/lib/session', () => ({
  getSession: (...args: unknown[]) => mockState.getSession(...args),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    $transaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
    clientProduct: { findUnique: (...args: unknown[]) => mockState.findUniqueClientProduct(...args) },
  },
}));

const RESOLVED = { clientId: 'client_1', email: 'a@b.com', source: 'database' as const };
const CLIENT_PRODUCT_ID = '11111111-1111-1111-1111-111111111111';
const WEB_CLIENT_PRODUCT = {
  id: CLIENT_PRODUCT_ID,
  clientId: 'client_1',
  tenantId: 'tenant_1',
  status: 'active',
  product: { code: 'web' },
};

beforeEach(() => {
  mockState.resolveClientFromSession.mockReset().mockResolvedValue(RESOLVED);
  mockState.getSession.mockReset().mockResolvedValue({ hasClientAccess: true });
  mockState.isDatabaseConfigured = true;
  mockState.findUniqueClientProduct.mockReset().mockResolvedValue(WEB_CLIENT_PRODUCT);
  mockState.webBriefFindUnique.mockReset().mockResolvedValue(null);
  mockState.webBriefUpsert.mockReset().mockResolvedValue({ id: 'brief_1' });
  mockState.webBriefAuditCreate.mockReset();
});

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

const VALID_SUBMIT = {
  clientProductId: CLIENT_PRODUCT_ID,
  businessName: 'Peluquería Aurora',
  goal: 'vender',
  pagesNeeded: ['Inicio', 'Contacto'],
  submit: true,
};

describe('POST /api/portal/web-brief', () => {
  it('401s without a session', async () => {
    mockState.resolveClientFromSession.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/portal/web-brief/route');
    const res = await POST(makeRequest(VALID_SUBMIT));
    expect(res.status).toBe(401);
  });

  it('503s outside real-database mode', async () => {
    mockState.resolveClientFromSession.mockResolvedValueOnce({ ...RESOLVED, source: 'mock_dev' });
    const { POST } = await import('@/app/api/portal/web-brief/route');
    const res = await POST(makeRequest(VALID_SUBMIT));
    expect(res.status).toBe(503);
    expect(mockState.webBriefUpsert).not.toHaveBeenCalled();
  });

  it('400s when clientProductId is missing or not a uuid', async () => {
    const { POST } = await import('@/app/api/portal/web-brief/route');
    const res = await POST(makeRequest({ ...VALID_SUBMIT, clientProductId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
    expect(mockState.webBriefUpsert).not.toHaveBeenCalled();
  });

  it('404s when the ClientProduct does not exist', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/portal/web-brief/route');
    const res = await POST(makeRequest(VALID_SUBMIT));
    expect(res.status).toBe(404);
    expect(mockState.webBriefUpsert).not.toHaveBeenCalled();
  });

  it("404s when the ClientProduct belongs to a different client", async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce({ ...WEB_CLIENT_PRODUCT, clientId: 'someone_else' });
    const { POST } = await import('@/app/api/portal/web-brief/route');
    const res = await POST(makeRequest(VALID_SUBMIT));
    expect(res.status).toBe(404);
    expect(mockState.webBriefUpsert).not.toHaveBeenCalled();
  });

  it("404s when the ClientProduct isn't a 'web' row", async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce({ ...WEB_CLIENT_PRODUCT, product: { code: 'leads' } });
    const { POST } = await import('@/app/api/portal/web-brief/route');
    const res = await POST(makeRequest(VALID_SUBMIT));
    expect(res.status).toBe(404);
  });

  it('404s when the web row is cancelled (not an accessible status)', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce({ ...WEB_CLIENT_PRODUCT, status: 'cancelled' });
    const { POST } = await import('@/app/api/portal/web-brief/route');
    const res = await POST(makeRequest(VALID_SUBMIT));
    expect(res.status).toBe(404);
  });

  it('allows saving while the row is quote_pending — the isProductContracted bug this route used to have', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce({ ...WEB_CLIENT_PRODUCT, status: 'quote_pending' });
    const { POST } = await import('@/app/api/portal/web-brief/route');
    const res = await POST(makeRequest({ submit: false, clientProductId: CLIENT_PRODUCT_ID, vertical: 'clínica dental' }));
    expect(res.status).toBe(200);
  });

  it('400s a submit missing required fields', async () => {
    const { POST } = await import('@/app/api/portal/web-brief/route');
    const res = await POST(makeRequest({ clientProductId: CLIENT_PRODUCT_ID, submit: true }));
    expect(res.status).toBe(400);
    expect(mockState.webBriefUpsert).not.toHaveBeenCalled();
  });

  it('saves an arbitrarily incomplete draft (submit: false)', async () => {
    const { POST } = await import('@/app/api/portal/web-brief/route');
    const res = await POST(makeRequest({ clientProductId: CLIENT_PRODUCT_ID, submit: false, vertical: 'clínica dental' }));
    expect(res.status).toBe(200);
    const body = await res.clone().json();
    expect(body).toEqual({ status: 'draft' });
    expect(mockState.webBriefUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clientProductId: CLIENT_PRODUCT_ID },
        create: expect.objectContaining({
          clientId: 'client_1',
          clientProductId: CLIENT_PRODUCT_ID,
          status: 'draft',
          vertical: 'clínica dental',
          submittedAt: null,
        }),
        update: expect.objectContaining({ status: 'draft', vertical: 'clínica dental' }),
      }),
    );
    const call = mockState.webBriefUpsert.mock.calls[0][0];
    expect(call.update.submittedAt).toBeUndefined();
    expect(mockState.webBriefAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ webBriefId: 'brief_1', clientId: 'client_1', action: 'draft_saved' }),
    });
  });

  it('submits successfully and stamps submittedAt', async () => {
    const { POST } = await import('@/app/api/portal/web-brief/route');
    const res = await POST(makeRequest(VALID_SUBMIT));
    expect(res.status).toBe(200);
    const body = await res.clone().json();
    expect(body).toEqual({ status: 'submitted' });
    expect(mockState.webBriefUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: 'submitted',
          businessName: 'Peluquería Aurora',
          goal: 'vender',
          pagesNeeded: ['Inicio', 'Contacto'],
          tenantId: 'tenant_1',
        }),
        update: expect.objectContaining({ status: 'submitted' }),
      }),
    );
    const call = mockState.webBriefUpsert.mock.calls[0][0];
    expect(call.create.submittedAt).toBeInstanceOf(Date);
    expect(call.update.submittedAt).toBeInstanceOf(Date);
    expect(mockState.webBriefAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'submitted' }),
    });
  });

  it('allows resubmitting after an already-submitted brief (no hard lock)', async () => {
    mockState.webBriefFindUnique.mockResolvedValueOnce({ id: 'brief_1', status: 'submitted' });
    const { POST } = await import('@/app/api/portal/web-brief/route');
    const res = await POST(makeRequest({ ...VALID_SUBMIT, additionalNotes: 'cambié de idea' }));
    expect(res.status).toBe(200);
    expect(mockState.webBriefUpsert).toHaveBeenCalledTimes(1);
    expect(mockState.webBriefAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ before: { id: 'brief_1', status: 'submitted' } }),
    });
  });
});
