// =============================================================================
// Unit tests for POST /api/admin/portal/web-quotes/[id]/send.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  requireTotpStepUp: vi.fn(),
  findUniqueWebQuote: vi.fn(),
  webQuoteUpdate: vi.fn(),
  webQuoteAuditCreate: vi.fn(),
}));

const mockTx = {
  webQuote: { update: (...args: unknown[]) => mockState.webQuoteUpdate(...args) },
  webQuoteAudit: { create: (...args: unknown[]) => mockState.webQuoteAuditCreate(...args) },
};

vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...args: unknown[]) => mockState.authenticateAdminRequest(...args),
}));

vi.mock('@/lib/operator-totp-stepup', () => ({
  requireTotpStepUp: (...args: unknown[]) => mockState.requireTotpStepUp(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
    webQuote: { findUnique: (...args: unknown[]) => mockState.findUniqueWebQuote(...args) },
  },
  isDatabaseConfigured: true,
}));

const AUTH_OK = { ok: true, sessionId: 's1', operatorId: 'op_1' };
const STEP_UP_OK = { ok: true, operatorId: 'op_1', sessionId: 's1' };

beforeEach(() => {
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue(AUTH_OK);
  mockState.requireTotpStepUp.mockReset().mockResolvedValue(STEP_UP_OK);
  mockState.findUniqueWebQuote.mockReset().mockResolvedValue({ id: 'wq_1', status: 'draft' });
  mockState.webQuoteUpdate.mockReset().mockResolvedValue({ id: 'wq_1', status: 'sent' });
  mockState.webQuoteAuditCreate.mockReset().mockResolvedValue({});
});

async function callRoute() {
  const { POST } = await import('@/app/api/admin/portal/web-quotes/[id]/send/route');
  return POST({} as NextRequest, { params: { id: 'wq_1' } });
}

describe('POST /api/admin/portal/web-quotes/[id]/send', () => {
  it('401s without a real operator session', async () => {
    mockState.authenticateAdminRequest.mockResolvedValueOnce({ ok: false });
    const res = await callRoute();
    expect(res.status).toBe(401);
    expect(mockState.webQuoteUpdate).not.toHaveBeenCalled();
  });

  it('403s without a fresh TOTP step-up', async () => {
    mockState.requireTotpStepUp.mockResolvedValueOnce({ ok: false, status: 403, error: 'totp_step_up_required' });
    const res = await callRoute();
    expect(res.status).toBe(403);
    expect(mockState.webQuoteUpdate).not.toHaveBeenCalled();
  });

  it('404s when the WebQuote does not exist', async () => {
    mockState.findUniqueWebQuote.mockResolvedValueOnce(null);
    const res = await callRoute();
    expect(res.status).toBe(404);
  });

  it('409s quote_locked when the quote is already accepted/invoiced/paid/cancelled', async () => {
    mockState.findUniqueWebQuote.mockResolvedValueOnce({ id: 'wq_1', status: 'accepted' });
    const res = await callRoute();
    expect(res.status).toBe(409);
    expect((await res.clone().json()).error).toBe('quote_locked');
  });

  it('200s and marks the quote sent on the happy path', async () => {
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(mockState.webQuoteUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'sent', sentByOperatorId: 'op_1' }) }),
    );
  });

  it('allows re-sending from sent (after an edit)', async () => {
    mockState.findUniqueWebQuote.mockResolvedValueOnce({ id: 'wq_1', status: 'sent' });
    const res = await callRoute();
    expect(res.status).toBe(200);
  });
});
