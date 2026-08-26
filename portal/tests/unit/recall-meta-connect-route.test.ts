// =============================================================================
// Fase 8 ('recall') — unit tests for POST /api/portal/recall/meta-connect.
//
// The coexistence connect's OWN logic is covered in recall-meta.test.ts;
// this file covers the HTTP layer only — auth, the 'recall' product
// gate (deliberately NOT getAllowedChannelsForClient, which is chatbot-
// tier-only and has no opinion on recall), and status-code mapping.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  getSession: vi.fn(),
  resolveClientFromSession: vi.fn(),
  isProductContracted: vi.fn(),
  isCoexistenceSignupConfigured: vi.fn(),
  connectRecallWhatsapp: vi.fn(),
  recallSubscriptionFindFirst: vi.fn(),
  logError: vi.fn(),
  isDatabaseConfigured: true,
}));

vi.mock('@/lib/session', () => ({
  getSession: (...a: unknown[]) => mockState.getSession(...a),
}));

vi.mock('@/lib/portal-session', () => ({
  resolveClientFromSession: (...a: unknown[]) => mockState.resolveClientFromSession(...a),
}));

vi.mock('@/lib/client-product-access', () => ({
  isProductContracted: (...a: unknown[]) => mockState.isProductContracted(...a),
}));

vi.mock('@/lib/meta-business', () => ({
  isCoexistenceSignupConfigured: (...a: unknown[]) => mockState.isCoexistenceSignupConfigured(...a),
}));

vi.mock('@/lib/recall-meta', () => ({
  connectRecallWhatsapp: (...a: unknown[]) => mockState.connectRecallWhatsapp(...a),
}));

vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    recallSubscription: { findFirst: (...a: unknown[]) => mockState.recallSubscriptionFindFirst(...a) },
  },
}));

import { POST } from '@/app/api/portal/recall/meta-connect/route';

const SESSION_OK = { hasClientAccess: true };
const RESOLVED = { clientId: 'client_1', email: 'a@b.com', source: 'database' as const };

function makeRequest(body?: unknown) {
  return { json: async () => body ?? null } as unknown as NextRequest;
}

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.getSession.mockReset().mockResolvedValue(SESSION_OK);
  mockState.resolveClientFromSession.mockReset().mockResolvedValue(RESOLVED);
  mockState.isProductContracted.mockReset().mockResolvedValue(true);
  mockState.isCoexistenceSignupConfigured.mockReset().mockReturnValue(true);
  mockState.recallSubscriptionFindFirst.mockReset().mockResolvedValue({ id: 'sub_1', tenantId: null });
  mockState.connectRecallWhatsapp.mockReset().mockResolvedValue({
    ok: true,
    connectionId: 'conn_1',
    displayPhoneNumber: '+34 611 22 33 44',
    advancedTo: 'meta_connected',
  });
  mockState.logError.mockReset();
});

describe('POST /api/portal/recall/meta-connect', () => {
  it('401s without a client session', async () => {
    mockState.getSession.mockResolvedValue({ hasClientAccess: false });
    const res = await POST(makeRequest({ code: 'c', wabaId: 'w' }));
    expect(res.status).toBe(401);
  });

  it('503s when the coexistence Configuration is not set up — independent of the standard one', async () => {
    mockState.isCoexistenceSignupConfigured.mockReturnValue(false);
    const res = await POST(makeRequest({ code: 'c', wabaId: 'w' }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: 'not_configured' });
  });

  it('400s on a malformed body', async () => {
    const res = await POST(makeRequest({ code: '' }));
    expect(res.status).toBe(400);
  });

  it('403s a client without the recall product — NOT gated on chatbot-tier channels', async () => {
    mockState.isProductContracted.mockResolvedValue(false);
    const res = await POST(makeRequest({ code: 'c', wabaId: 'w' }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: 'forbidden' });
  });

  it('404s when the client has no recall subscription row at all', async () => {
    mockState.recallSubscriptionFindFirst.mockResolvedValue(null);
    const res = await POST(makeRequest({ code: 'c', wabaId: 'w' }));
    expect(res.status).toBe(404);
  });

  it('maps invalid_status from the lib function to 409', async () => {
    mockState.connectRecallWhatsapp.mockResolvedValue({ ok: false, error: 'invalid_status' });
    const res = await POST(makeRequest({ code: 'c', wabaId: 'w' }));
    expect(res.status).toBe(409);
  });

  it('maps phone_number_not_found to 502', async () => {
    mockState.connectRecallWhatsapp.mockResolvedValue({ ok: false, error: 'phone_number_not_found' });
    const res = await POST(makeRequest({ code: 'c', wabaId: 'w' }));
    expect(res.status).toBe(502);
  });

  it('returns 200 with the connection summary on success', async () => {
    const res = await POST(makeRequest({ code: 'c', wabaId: 'w' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, displayPhoneNumber: '+34 611 22 33 44', advancedTo: 'meta_connected' });
  });

  it('500s cleanly and logs when connectRecallWhatsapp throws — never lets a raw exception escape', async () => {
    mockState.connectRecallWhatsapp.mockRejectedValue(new Error('boom'));
    const res = await POST(makeRequest({ code: 'c', wabaId: 'w' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'internal_error' });
    expect(mockState.logError).toHaveBeenCalled();
  });
});
