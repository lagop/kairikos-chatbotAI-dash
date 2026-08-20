// =============================================================================
// Unit tests for POST /api/portal/web-brief.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  resolveClientFromSession: vi.fn(),
  getSession: vi.fn(),
  isDatabaseConfigured: true,
  isProductContracted: vi.fn(),
  webBriefUpsert: vi.fn(),
  findUniqueClient: vi.fn(),
}));

vi.mock('@/lib/portal-session', () => ({
  resolveClientFromSession: (...args: unknown[]) => mockState.resolveClientFromSession(...args),
}));

vi.mock('@/lib/session', () => ({
  getSession: (...args: unknown[]) => mockState.getSession(...args),
}));

vi.mock('@/lib/client-product-access', () => ({
  isProductContracted: (...args: unknown[]) => mockState.isProductContracted(...args),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    webBrief: { upsert: (...args: unknown[]) => mockState.webBriefUpsert(...args) },
    chatbotClient: { findUnique: (...args: unknown[]) => mockState.findUniqueClient(...args) },
  },
}));

const RESOLVED = { clientId: 'client_1', email: 'a@b.com', source: 'database' as const };

beforeEach(() => {
  mockState.resolveClientFromSession.mockReset().mockResolvedValue(RESOLVED);
  mockState.getSession.mockReset().mockResolvedValue({ hasClientAccess: true });
  mockState.isDatabaseConfigured = true;
  mockState.isProductContracted.mockReset().mockResolvedValue(true);
  mockState.webBriefUpsert.mockReset().mockResolvedValue({});
  mockState.findUniqueClient.mockReset().mockResolvedValue({ tenantId: 'tenant_1' });
});

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

const VALID_SUBMIT = {
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

  it('404s when the client does not have web contracted', async () => {
    mockState.isProductContracted.mockResolvedValueOnce(false);
    const { POST } = await import('@/app/api/portal/web-brief/route');
    const res = await POST(makeRequest(VALID_SUBMIT));
    expect(res.status).toBe(404);
    expect(mockState.webBriefUpsert).not.toHaveBeenCalled();
  });

  it('400s a submit missing required fields', async () => {
    const { POST } = await import('@/app/api/portal/web-brief/route');
    const res = await POST(makeRequest({ submit: true }));
    expect(res.status).toBe(400);
    expect(mockState.webBriefUpsert).not.toHaveBeenCalled();
  });

  it('saves an arbitrarily incomplete draft (submit: false)', async () => {
    const { POST } = await import('@/app/api/portal/web-brief/route');
    const res = await POST(makeRequest({ submit: false, vertical: 'clínica dental' }));
    expect(res.status).toBe(200);
    const body = await res.clone().json();
    expect(body).toEqual({ status: 'draft' });
    expect(mockState.webBriefUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clientId: 'client_1' },
        create: expect.objectContaining({ status: 'draft', vertical: 'clínica dental', submittedAt: null }),
        update: expect.objectContaining({ status: 'draft', vertical: 'clínica dental' }),
      }),
    );
    // A draft save never stamps submittedAt on the update branch either.
    const call = mockState.webBriefUpsert.mock.calls[0][0];
    expect(call.update.submittedAt).toBeUndefined();
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
  });

  it('allows resubmitting after an already-submitted brief (no hard lock)', async () => {
    const { POST } = await import('@/app/api/portal/web-brief/route');
    const res = await POST(makeRequest({ ...VALID_SUBMIT, additionalNotes: 'cambié de idea' }));
    expect(res.status).toBe(200);
    expect(mockState.webBriefUpsert).toHaveBeenCalledTimes(1);
  });
});
