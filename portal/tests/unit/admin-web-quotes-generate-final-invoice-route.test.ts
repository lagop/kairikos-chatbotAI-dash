// =============================================================================
// Unit tests for POST /api/admin/portal/web-quotes/[id]/generate-final-invoice.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  requireTotpStepUp: vi.fn(),
  isStripeConfigured: vi.fn(),
  findUniqueWebQuote: vi.fn(),
  findUniqueClientProduct: vi.fn(),
  findUniqueInvoice: vi.fn(),
  findUniqueChatbotClient: vi.fn(),
  ensureCustomerForTenant: vi.fn(),
  createWebQuoteInvoice: vi.fn(),
  syncInvoiceFromStripe: vi.fn(),
  webQuoteUpdate: vi.fn(),
  webQuoteAuditCreate: vi.fn(),
  sendWebQuoteInvoiceEmail: vi.fn(),
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

vi.mock('@/lib/stripe', () => ({
  isStripeConfigured: (...args: unknown[]) => mockState.isStripeConfigured(...args),
}));

vi.mock('@/lib/stripe-billing', () => ({
  ensureCustomerForTenant: (...args: unknown[]) => mockState.ensureCustomerForTenant(...args),
  createWebQuoteInvoice: (...args: unknown[]) => mockState.createWebQuoteInvoice(...args),
  syncInvoiceFromStripe: (...args: unknown[]) => mockState.syncInvoiceFromStripe(...args),
}));

vi.mock('@/lib/web-quote-email', () => ({
  sendWebQuoteInvoiceEmail: (...args: unknown[]) => mockState.sendWebQuoteInvoiceEmail(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
    webQuote: { findUnique: (...args: unknown[]) => mockState.findUniqueWebQuote(...args) },
    clientProduct: { findUnique: (...args: unknown[]) => mockState.findUniqueClientProduct(...args) },
    invoice: { findUnique: (...args: unknown[]) => mockState.findUniqueInvoice(...args) },
    chatbotClient: { findUnique: (...args: unknown[]) => mockState.findUniqueChatbotClient(...args) },
  },
  isDatabaseConfigured: true,
}));

const AUTH_OK = { ok: true, sessionId: 's1', operatorId: 'op_1' };
const STEP_UP_OK = { ok: true, operatorId: 'op_1', sessionId: 's1' };
const DEPOSIT_PAID_QUOTE = {
  id: 'wq_1',
  clientId: 'client_1',
  clientProductId: 'cp_1',
  status: 'deposit_paid',
  amountCents: 99900,
  depositCents: 30000,
  currency: 'eur',
  description: 'Sitio web a medida',
};

beforeEach(() => {
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue(AUTH_OK);
  mockState.requireTotpStepUp.mockReset().mockResolvedValue(STEP_UP_OK);
  mockState.isStripeConfigured.mockReset().mockResolvedValue(true);
  mockState.findUniqueWebQuote.mockReset().mockResolvedValue(DEPOSIT_PAID_QUOTE);
  mockState.findUniqueClientProduct.mockReset().mockResolvedValue({ id: 'cp_1', tenantId: 'tenant_1' });
  mockState.findUniqueInvoice.mockReset().mockResolvedValue({ id: 'inv_2', stripeId: 'in_2' });
  mockState.ensureCustomerForTenant.mockReset().mockResolvedValue('cus_1');
  mockState.createWebQuoteInvoice.mockReset().mockResolvedValue({ id: 'in_2', status: 'open' });
  mockState.syncInvoiceFromStripe.mockReset().mockResolvedValue(undefined);
  mockState.webQuoteUpdate.mockReset().mockResolvedValue({ ...DEPOSIT_PAID_QUOTE, status: 'invoiced_final' });
  mockState.webQuoteAuditCreate.mockReset().mockResolvedValue({});
  mockState.findUniqueChatbotClient.mockReset().mockResolvedValue({ email: 'aurora@example.com', companyName: 'Peluquería Aurora', name: 'Aurora' });
  mockState.sendWebQuoteInvoiceEmail.mockReset().mockResolvedValue({ ok: true, messageId: 'msg_1' });
});

async function callRoute() {
  const { POST } = await import('@/app/api/admin/portal/web-quotes/[id]/generate-final-invoice/route');
  return POST({} as NextRequest, { params: { id: 'wq_1' } });
}

describe('POST /api/admin/portal/web-quotes/[id]/generate-final-invoice', () => {
  it('403s without a fresh TOTP step-up', async () => {
    mockState.requireTotpStepUp.mockResolvedValueOnce({ ok: false, status: 403, error: 'totp_step_up_required' });
    const res = await callRoute();
    expect(res.status).toBe(403);
    expect(mockState.createWebQuoteInvoice).not.toHaveBeenCalled();
  });

  it('503s when Stripe is not configured', async () => {
    mockState.isStripeConfigured.mockResolvedValueOnce(false);
    const res = await callRoute();
    expect(res.status).toBe(503);
  });

  it('409s not_deposit_paid when the quote is not in the deposit_paid state', async () => {
    mockState.findUniqueWebQuote.mockResolvedValueOnce({ ...DEPOSIT_PAID_QUOTE, status: 'invoiced_deposit' });
    const res = await callRoute();
    expect(res.status).toBe(409);
    expect((await res.clone().json()).error).toBe('not_deposit_paid');
    expect(mockState.createWebQuoteInvoice).not.toHaveBeenCalled();
  });

  it('invoices the remaining balance (amountCents - depositCents) with role=final', async () => {
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(mockState.createWebQuoteInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeCustomerId: 'cus_1',
        amountCents: 69900,
        metadata: expect.objectContaining({ kairikos_invoice_role: 'final', kairikos_web_quote_id: 'wq_1' }),
      }),
    );
    expect(mockState.syncInvoiceFromStripe).toHaveBeenCalled();
    expect(mockState.webQuoteUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'invoiced_final' } }),
    );
  });

  it('502s stripe_error when the Stripe call throws', async () => {
    mockState.createWebQuoteInvoice.mockRejectedValueOnce(new Error('stripe down'));
    const res = await callRoute();
    expect(res.status).toBe(502);
    expect(mockState.webQuoteUpdate).not.toHaveBeenCalled();
  });

  it('still 200s when the notification email fails (best-effort, never blocks the response)', async () => {
    mockState.sendWebQuoteInvoiceEmail.mockResolvedValueOnce({ ok: false, error: 'resend down' });
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect((await res.clone().json()).ok).toBe(true);
  });
});
