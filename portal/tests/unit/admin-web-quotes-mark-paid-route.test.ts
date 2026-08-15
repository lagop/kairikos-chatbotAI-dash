// =============================================================================
// Unit tests for POST /api/admin/portal/web-quotes/[id]/mark-paid.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  requireTotpStepUp: vi.fn(),
  findUniqueWebQuote: vi.fn(),
  findFirstInvoice: vi.fn(),
  markInvoicePaidManually: vi.fn(),
}));

vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...args: unknown[]) => mockState.authenticateAdminRequest(...args),
}));

vi.mock('@/lib/operator-totp-stepup', () => ({
  requireTotpStepUp: (...args: unknown[]) => mockState.requireTotpStepUp(...args),
}));

vi.mock('@/lib/stripe-billing', () => ({
  markInvoicePaidManually: (...args: unknown[]) => mockState.markInvoicePaidManually(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    webQuote: { findUnique: (...args: unknown[]) => mockState.findUniqueWebQuote(...args) },
    invoice: { findFirst: (...args: unknown[]) => mockState.findFirstInvoice(...args) },
  },
  isDatabaseConfigured: true,
}));

const AUTH_OK = { ok: true, sessionId: 's1', operatorId: 'op_1' };
const STEP_UP_OK = { ok: true, operatorId: 'op_1', sessionId: 's1' };
const INVOICED_QUOTE = { id: 'wq_1', clientProductId: 'cp_1', status: 'invoiced' };

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue(AUTH_OK);
  mockState.requireTotpStepUp.mockReset().mockResolvedValue(STEP_UP_OK);
  mockState.findUniqueWebQuote.mockReset().mockResolvedValue(INVOICED_QUOTE);
  mockState.findFirstInvoice.mockReset().mockResolvedValue({ id: 'inv_1', stripeId: 'in_1' });
  mockState.markInvoicePaidManually.mockReset().mockResolvedValue({ ok: true });
});

async function callRoute(body: unknown = { channel: 'transfer', reference: 'TRF-1' }) {
  const { POST } = await import('@/app/api/admin/portal/web-quotes/[id]/mark-paid/route');
  return POST(makeRequest(body), { params: { id: 'wq_1' } });
}

describe('POST /api/admin/portal/web-quotes/[id]/mark-paid', () => {
  it('403s without a fresh TOTP step-up', async () => {
    mockState.requireTotpStepUp.mockResolvedValueOnce({ ok: false, status: 403, error: 'totp_step_up_required' });
    const res = await callRoute();
    expect(res.status).toBe(403);
    expect(mockState.markInvoicePaidManually).not.toHaveBeenCalled();
  });

  it('400s an invalid channel (e.g. "stripe" — that path is not manual)', async () => {
    const res = await callRoute({ channel: 'stripe', reference: 'x' });
    expect(res.status).toBe(400);
    expect(mockState.markInvoicePaidManually).not.toHaveBeenCalled();
  });

  it('400s a missing reference', async () => {
    const res = await callRoute({ channel: 'cash', reference: '' });
    expect(res.status).toBe(400);
  });

  it('409s not_invoiced when the quote is not in an invoiced state', async () => {
    mockState.findUniqueWebQuote.mockResolvedValueOnce({ ...INVOICED_QUOTE, status: 'accepted' });
    const res = await callRoute();
    expect(res.status).toBe(409);
    expect((await res.clone().json()).error).toBe('not_invoiced');
  });

  it.each(['invoiced_deposit', 'invoiced_final'])(
    '200s from %s (WebQuote v2 — manual payment works on the deposit/final invoice too)',
    async (status) => {
      mockState.findUniqueWebQuote.mockResolvedValueOnce({ ...INVOICED_QUOTE, status });
      const res = await callRoute();
      expect(res.status).toBe(200);
    },
  );

  it('404s when there is no Invoice for this quote yet', async () => {
    mockState.findFirstInvoice.mockResolvedValueOnce(null);
    const res = await callRoute();
    expect(res.status).toBe(404);
    expect(mockState.markInvoicePaidManually).not.toHaveBeenCalled();
  });

  it('200s on the happy path and passes channel/reference/operator through', async () => {
    const res = await callRoute({ channel: 'cash', reference: 'caja chica' });
    expect(res.status).toBe(200);
    expect(mockState.markInvoicePaidManually).toHaveBeenCalledWith({
      invoiceId: 'inv_1',
      channel: 'cash',
      reference: 'caja chica',
      markedByOperatorId: 'op_1',
    });
  });

  it('502s stripe_error when markInvoicePaidManually fails against Stripe', async () => {
    mockState.markInvoicePaidManually.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'stripe_error', detail: 'invoice voided' },
    });
    const res = await callRoute();
    expect(res.status).toBe(502);
  });
});
