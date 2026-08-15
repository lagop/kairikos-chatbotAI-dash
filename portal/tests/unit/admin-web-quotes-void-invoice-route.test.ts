// =============================================================================
// Unit tests for POST /api/admin/portal/web-quotes/[id]/void-invoice.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  requireTotpStepUp: vi.fn(),
  findUniqueWebQuote: vi.fn(),
  findFirstInvoice: vi.fn(),
  voidWebQuoteInvoice: vi.fn(),
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

vi.mock('@/lib/stripe-billing', () => ({
  voidWebQuoteInvoice: (...args: unknown[]) => mockState.voidWebQuoteInvoice(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
    webQuote: { findUnique: (...args: unknown[]) => mockState.findUniqueWebQuote(...args) },
    invoice: { findFirst: (...args: unknown[]) => mockState.findFirstInvoice(...args) },
  },
  isDatabaseConfigured: true,
}));

const AUTH_OK = { ok: true, sessionId: 's1', operatorId: 'op_1' };
const STEP_UP_OK = { ok: true, operatorId: 'op_1', sessionId: 's1' };
const INVOICED_QUOTE = { id: 'wq_1', clientProductId: 'cp_1', status: 'invoiced' };

beforeEach(() => {
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue(AUTH_OK);
  mockState.requireTotpStepUp.mockReset().mockResolvedValue(STEP_UP_OK);
  mockState.findUniqueWebQuote.mockReset().mockResolvedValue(INVOICED_QUOTE);
  mockState.findFirstInvoice.mockReset().mockResolvedValue({ id: 'inv_1', stripeId: 'in_1' });
  mockState.voidWebQuoteInvoice.mockReset().mockResolvedValue({ ok: true });
  mockState.webQuoteUpdate.mockReset().mockResolvedValue({ ...INVOICED_QUOTE, status: 'cancelled' });
  mockState.webQuoteAuditCreate.mockReset().mockResolvedValue({});
});

async function callRoute() {
  const { POST } = await import('@/app/api/admin/portal/web-quotes/[id]/void-invoice/route');
  return POST({} as NextRequest, { params: { id: 'wq_1' } });
}

describe('POST /api/admin/portal/web-quotes/[id]/void-invoice', () => {
  it('403s without a fresh TOTP step-up', async () => {
    mockState.requireTotpStepUp.mockResolvedValueOnce({ ok: false, status: 403, error: 'totp_step_up_required' });
    const res = await callRoute();
    expect(res.status).toBe(403);
    expect(mockState.voidWebQuoteInvoice).not.toHaveBeenCalled();
  });

  it('404s when the WebQuote does not exist', async () => {
    mockState.findUniqueWebQuote.mockResolvedValueOnce(null);
    const res = await callRoute();
    expect(res.status).toBe(404);
  });

  it.each(['draft', 'sent', 'accepted', 'deposit_paid', 'paid', 'cancelled'])(
    '409s cannot_void when the quote is %s',
    async (status) => {
      mockState.findUniqueWebQuote.mockResolvedValueOnce({ ...INVOICED_QUOTE, status });
      const res = await callRoute();
      expect(res.status).toBe(409);
      expect((await res.clone().json()).error).toBe('cannot_void');
      expect(mockState.voidWebQuoteInvoice).not.toHaveBeenCalled();
    },
  );

  it.each(['invoiced', 'invoiced_deposit', 'invoiced_final'])('200s and cancels the quote from %s', async (status) => {
    mockState.findUniqueWebQuote.mockResolvedValueOnce({ ...INVOICED_QUOTE, status });
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(mockState.voidWebQuoteInvoice).toHaveBeenCalledWith({ invoiceId: 'inv_1' });
    expect(mockState.webQuoteUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'cancelled' }) }),
    );
    expect(mockState.webQuoteAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'invoice_voided' }) }),
    );
  });

  it('404s when there is no Invoice for this quote yet', async () => {
    mockState.findFirstInvoice.mockResolvedValueOnce(null);
    const res = await callRoute();
    expect(res.status).toBe(404);
    expect(mockState.voidWebQuoteInvoice).not.toHaveBeenCalled();
  });

  it('409s already_paid when Stripe reports the invoice was already paid', async () => {
    mockState.voidWebQuoteInvoice.mockResolvedValueOnce({ ok: false, error: { kind: 'already_paid' } });
    const res = await callRoute();
    expect(res.status).toBe(409);
    expect((await res.clone().json()).error).toBe('already_paid');
    expect(mockState.webQuoteUpdate).not.toHaveBeenCalled();
  });

  it('502s stripe_error when voidWebQuoteInvoice fails against Stripe', async () => {
    mockState.voidWebQuoteInvoice.mockResolvedValueOnce({ ok: false, error: { kind: 'stripe_error', detail: 'boom' } });
    const res = await callRoute();
    expect(res.status).toBe(502);
    expect(mockState.webQuoteUpdate).not.toHaveBeenCalled();
  });
});
