// =============================================================================
// Unit tests for POST /api/admin/portal/web-quotes/[id]/generate-invoice.
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
const ACCEPTED_QUOTE = {
  id: 'wq_1',
  clientId: 'client_1',
  clientProductId: 'cp_1',
  status: 'accepted',
  amountCents: 99900,
  depositCents: null,
  currency: 'eur',
  description: 'Sitio web a medida',
};

beforeEach(() => {
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue(AUTH_OK);
  mockState.requireTotpStepUp.mockReset().mockResolvedValue(STEP_UP_OK);
  mockState.isStripeConfigured.mockReset().mockResolvedValue(true);
  mockState.findUniqueWebQuote.mockReset().mockResolvedValue(ACCEPTED_QUOTE);
  mockState.findUniqueClientProduct.mockReset().mockResolvedValue({ id: 'cp_1', tenantId: 'tenant_1' });
  mockState.findUniqueInvoice.mockReset().mockResolvedValue({ id: 'inv_1', stripeId: 'in_1' });
  mockState.ensureCustomerForTenant.mockReset().mockResolvedValue('cus_1');
  mockState.createWebQuoteInvoice.mockReset().mockResolvedValue({ id: 'in_1', status: 'open' });
  mockState.syncInvoiceFromStripe.mockReset().mockResolvedValue(undefined);
  mockState.webQuoteUpdate.mockReset().mockResolvedValue({ ...ACCEPTED_QUOTE, status: 'invoiced' });
  mockState.webQuoteAuditCreate.mockReset().mockResolvedValue({});
  mockState.findUniqueChatbotClient.mockReset().mockResolvedValue({ email: 'aurora@example.com', companyName: 'Peluquería Aurora', name: 'Aurora' });
  mockState.sendWebQuoteInvoiceEmail.mockReset().mockResolvedValue({ ok: true, messageId: 'msg_1' });
});

async function callRoute() {
  const { POST } = await import('@/app/api/admin/portal/web-quotes/[id]/generate-invoice/route');
  return POST({} as NextRequest, { params: { id: 'wq_1' } });
}

describe('POST /api/admin/portal/web-quotes/[id]/generate-invoice', () => {
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

  it('409s not_accepted when the quote is not in the accepted state', async () => {
    mockState.findUniqueWebQuote.mockResolvedValueOnce({ ...ACCEPTED_QUOTE, status: 'sent' });
    const res = await callRoute();
    expect(res.status).toBe(409);
    expect((await res.clone().json()).error).toBe('not_accepted');
    expect(mockState.createWebQuoteInvoice).not.toHaveBeenCalled();
  });

  it('creates the invoice with the quote amount/description and marks the quote invoiced', async () => {
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(mockState.createWebQuoteInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeCustomerId: 'cus_1',
        amountCents: 99900,
        currency: 'eur',
        description: 'Sitio web a medida',
        metadata: expect.objectContaining({
          kairikos_web_quote_id: 'wq_1',
          kairikos_client_product_id: 'cp_1',
          kairikos_invoice_role: 'full',
        }),
      }),
    );
    expect(mockState.syncInvoiceFromStripe).toHaveBeenCalled();
    expect(mockState.webQuoteUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'invoiced' } }),
    );
  });

  it('502s stripe_error when the Stripe call throws', async () => {
    mockState.createWebQuoteInvoice.mockRejectedValueOnce(new Error('stripe down'));
    const res = await callRoute();
    expect(res.status).toBe(502);
    expect(mockState.webQuoteUpdate).not.toHaveBeenCalled();
  });

  it('with a depositCents set, invoices only the deposit and marks the quote invoiced_deposit', async () => {
    mockState.findUniqueWebQuote.mockResolvedValueOnce({ ...ACCEPTED_QUOTE, depositCents: 30000 });
    mockState.webQuoteUpdate.mockResolvedValueOnce({ ...ACCEPTED_QUOTE, depositCents: 30000, status: 'invoiced_deposit' });

    const res = await callRoute();

    expect(res.status).toBe(200);
    expect(mockState.createWebQuoteInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 30000,
        metadata: expect.objectContaining({ kairikos_invoice_role: 'deposit' }),
      }),
    );
    expect(mockState.webQuoteUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'invoiced_deposit' } }),
    );
  });

  it('still 200s when the notification email fails (best-effort, never blocks the response)', async () => {
    mockState.sendWebQuoteInvoiceEmail.mockResolvedValueOnce({ ok: false, error: 'resend down' });
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect((await res.clone().json()).ok).toBe(true);
  });
});
