// =============================================================================
// Unit tests for the WebQuote billing additions to src/lib/stripe-billing.ts:
// createWebQuoteInvoice, markInvoicePaidManually,
// activateClientProductFromWebQuotePayment — plus a regression pin that
// syncInvoiceFromStripe never writes the manual-payment columns.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  invoicesCreate: vi.fn(),
  invoiceItemsCreate: vi.fn(),
  invoicesFinalize: vi.fn(),
  invoicesPay: vi.fn(),
  invoicesVoid: vi.fn(),
  findUniqueInvoice: vi.fn(),
  invoiceUpdate: vi.fn(),
  invoiceUpsert: vi.fn(),
  findUniqueWebQuote: vi.fn(),
  webQuoteUpdate: vi.fn(),
  webQuoteAuditCreate: vi.fn(),
  findUniqueClientProduct: vi.fn(),
  clientProductUpdate: vi.fn(),
  clientProductAuditCreate: vi.fn(),
  callOrder: [] as string[],
}));

const mockTx = {
  invoice: {
    update: (...args: unknown[]) => {
      mockState.callOrder.push('prisma.invoice.update');
      return mockState.invoiceUpdate(...args);
    },
  },
  webQuote: { update: (...args: unknown[]) => mockState.webQuoteUpdate(...args) },
  webQuoteAudit: { create: (...args: unknown[]) => mockState.webQuoteAuditCreate(...args) },
  clientProduct: { update: (...args: unknown[]) => mockState.clientProductUpdate(...args) },
  clientProductAudit: { create: (...args: unknown[]) => mockState.clientProductAuditCreate(...args) },
};

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
    invoice: {
      findUnique: (...args: unknown[]) => mockState.findUniqueInvoice(...args),
      update: (...args: unknown[]) => mockState.invoiceUpdate(...args),
      upsert: (...args: unknown[]) => mockState.invoiceUpsert(...args),
    },
    webQuote: {
      findUnique: (...args: unknown[]) => mockState.findUniqueWebQuote(...args),
      update: (...args: unknown[]) => mockState.webQuoteUpdate(...args),
    },
    webQuoteAudit: {
      create: (...args: unknown[]) => mockState.webQuoteAuditCreate(...args),
    },
    clientProduct: {
      findUnique: (...args: unknown[]) => mockState.findUniqueClientProduct(...args),
      update: (...args: unknown[]) => mockState.clientProductUpdate(...args),
    },
  },
}));

vi.mock('@/lib/stripe', () => ({
  isStripeConfigured: () => true,
  getStripe: () => ({
    invoices: {
      create: (...args: unknown[]) => mockState.invoicesCreate(...args),
      finalizeInvoice: (...args: unknown[]) => mockState.invoicesFinalize(...args),
      pay: (...args: unknown[]) => {
        mockState.callOrder.push('stripe.invoices.pay');
        return mockState.invoicesPay(...args);
      },
      voidInvoice: (...args: unknown[]) => mockState.invoicesVoid(...args),
    },
    invoiceItems: {
      create: (...args: unknown[]) => mockState.invoiceItemsCreate(...args),
    },
  }),
  StripeUnavailableError: class StripeUnavailableError extends Error {},
}));

import {
  createWebQuoteInvoice,
  markInvoicePaidManually,
  activateClientProductFromWebQuotePayment,
  syncInvoiceFromStripe,
  voidWebQuoteInvoice,
} from '@/lib/stripe-billing';

beforeEach(() => {
  Object.values(mockState).forEach((v) => {
    if (typeof (v as { mockReset?: () => void }).mockReset === 'function') {
      (v as { mockReset: () => void }).mockReset();
    }
  });
  mockState.callOrder.length = 0;
  mockState.invoicesCreate.mockResolvedValue({ id: 'in_draft_1' });
  mockState.invoiceItemsCreate.mockResolvedValue({ id: 'ii_1' });
  mockState.invoicesFinalize.mockResolvedValue({ id: 'in_draft_1', status: 'open' });
  mockState.invoiceUpdate.mockResolvedValue({});
  mockState.webQuoteUpdate.mockResolvedValue({});
  mockState.webQuoteAuditCreate.mockResolvedValue({});
  mockState.clientProductUpdate.mockResolvedValue({});
  mockState.clientProductAuditCreate.mockResolvedValue({});
});

describe('createWebQuoteInvoice', () => {
  it('creates the invoice item with an ad-hoc amount/currency/description — no price/product', async () => {
    await createWebQuoteInvoice({
      stripeCustomerId: 'cus_1',
      amountCents: 99900,
      currency: 'eur',
      description: 'Sitio web a medida — 5 páginas',
      metadata: { kairikos_client_product_id: 'cp_1', kairikos_web_quote_id: 'wq_1' },
    });

    expect(mockState.invoicesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_1',
        collection_method: 'send_invoice',
        days_until_due: 14,
        auto_advance: false,
      }),
    );
    const itemCall = mockState.invoiceItemsCreate.mock.calls[0][0];
    expect(itemCall).toEqual({
      customer: 'cus_1',
      invoice: 'in_draft_1',
      amount: 99900,
      currency: 'eur',
      description: 'Sitio web a medida — 5 páginas',
    });
    expect(itemCall.price).toBeUndefined();
    expect(itemCall.product).toBeUndefined();
    expect(mockState.invoicesFinalize).toHaveBeenCalledWith('in_draft_1');
  });
});

describe('markInvoicePaidManually', () => {
  const INVOICE = { id: 'inv_1', stripeId: 'in_stripe_1', status: 'open', clientProductId: 'cp_1' };

  it('returns invoice_not_found when the invoice does not exist', async () => {
    mockState.findUniqueInvoice.mockResolvedValueOnce(null);
    const result = await markInvoicePaidManually({
      invoiceId: 'inv_missing',
      channel: 'transfer',
      reference: 'REF-1',
      markedByOperatorId: 'op_1',
    });
    expect(result).toEqual({ ok: false, error: { kind: 'invoice_not_found' } });
    expect(mockState.invoicesPay).not.toHaveBeenCalled();
  });

  it('returns already_paid without calling Stripe when the invoice is already paid', async () => {
    mockState.findUniqueInvoice.mockResolvedValueOnce({ ...INVOICE, status: 'paid' });
    const result = await markInvoicePaidManually({
      invoiceId: 'inv_1',
      channel: 'cash',
      reference: '',
      markedByOperatorId: 'op_1',
    });
    expect(result).toEqual({ ok: false, error: { kind: 'already_paid' } });
    expect(mockState.invoicesPay).not.toHaveBeenCalled();
  });

  it('persists channel/reference in Prisma BEFORE calling stripe.invoices.pay', async () => {
    mockState.findUniqueInvoice.mockResolvedValueOnce(INVOICE);
    mockState.findUniqueWebQuote.mockResolvedValueOnce({ id: 'wq_1', clientProductId: 'cp_1', status: 'invoiced' });
    mockState.invoicesPay.mockResolvedValueOnce({ id: 'in_stripe_1', status: 'paid' });

    const result = await markInvoicePaidManually({
      invoiceId: 'inv_1',
      channel: 'transfer',
      reference: 'TRF-2026-001',
      markedByOperatorId: 'op_1',
    });

    expect(result).toEqual({ ok: true });
    expect(mockState.invoiceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'inv_1' },
        data: expect.objectContaining({
          paymentChannel: 'transfer',
          paymentReference: 'TRF-2026-001',
          markedPaidByOperatorId: 'op_1',
        }),
      }),
    );
    expect(mockState.invoicesPay).toHaveBeenCalledWith('in_stripe_1', { paid_out_of_band: true });
    // The critical ordering guarantee: local write commits before Stripe is called.
    expect(mockState.callOrder).toEqual(['prisma.invoice.update', 'stripe.invoices.pay']);
  });

  it('returns stripe_error and records mark_paid_failed when Stripe rejects the call, without crashing', async () => {
    mockState.findUniqueInvoice.mockResolvedValueOnce(INVOICE);
    mockState.findUniqueWebQuote.mockResolvedValueOnce({ id: 'wq_1', clientProductId: 'cp_1', status: 'invoiced' });
    mockState.invoicesPay.mockRejectedValueOnce(new Error('invoice already voided'));

    const result = await markInvoicePaidManually({
      invoiceId: 'inv_1',
      channel: 'cash',
      reference: 'caja chica',
      markedByOperatorId: 'op_1',
    });

    expect(result).toEqual({ ok: false, error: { kind: 'stripe_error', detail: 'invoice already voided' } });
    expect(mockState.webQuoteAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'mark_paid_failed' }) }),
    );
  });
});

describe('activateClientProductFromWebQuotePayment', () => {
  const STRIPE_INVOICE = {
    metadata: { kairikos_client_product_id: 'cp_1' },
  } as unknown as Parameters<typeof activateClientProductFromWebQuotePayment>[0];

  it('is a no-op when the metadata has no kairikos_client_product_id', async () => {
    await activateClientProductFromWebQuotePayment({ metadata: {} } as never);
    expect(mockState.findUniqueClientProduct).not.toHaveBeenCalled();
  });

  it('is a no-op when the ClientProduct is not quote_pending', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce({
      id: 'cp_1', clientId: 'c1', productId: 'p1', tenantId: 't1', status: 'active', product: { code: 'web' },
    });
    await activateClientProductFromWebQuotePayment(STRIPE_INVOICE);
    expect(mockState.clientProductUpdate).not.toHaveBeenCalled();
  });

  it('is a no-op when the product is not web (defensive)', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce({
      id: 'cp_1', clientId: 'c1', productId: 'p1', tenantId: 't1', status: 'quote_pending', product: { code: 'chatbot' },
    });
    await activateClientProductFromWebQuotePayment(STRIPE_INVOICE);
    expect(mockState.clientProductUpdate).not.toHaveBeenCalled();
  });

  it('is a no-op when the WebQuote is already paid (idempotent)', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce({
      id: 'cp_1', clientId: 'c1', productId: 'p1', tenantId: 't1', status: 'quote_pending', product: { code: 'web' },
    });
    mockState.findUniqueWebQuote.mockResolvedValueOnce({ id: 'wq_1', status: 'paid' });
    await activateClientProductFromWebQuotePayment(STRIPE_INVOICE);
    expect(mockState.clientProductUpdate).not.toHaveBeenCalled();
  });

  it('activates the ClientProduct and marks the WebQuote paid on the happy path', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce({
      id: 'cp_1', clientId: 'c1', productId: 'p1', tenantId: 't1', status: 'quote_pending', product: { code: 'web' },
    });
    mockState.findUniqueWebQuote.mockResolvedValueOnce({ id: 'wq_1', status: 'invoiced' });
    mockState.clientProductUpdate.mockResolvedValueOnce({ id: 'cp_1', clientId: 'c1', productId: 'p1', tenantId: 't1' });

    await activateClientProductFromWebQuotePayment(STRIPE_INVOICE);

    expect(mockState.clientProductUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cp_1' }, data: expect.objectContaining({ status: 'active' }) }),
    );
    expect(mockState.clientProductAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'web_quote_paid', statusAfter: 'active' }) }),
    );
    expect(mockState.webQuoteUpdate).toHaveBeenCalledWith({ where: { id: 'wq_1' }, data: { status: 'paid' } });
  });

  const DEPOSIT_INVOICE = {
    metadata: { kairikos_client_product_id: 'cp_1', kairikos_invoice_role: 'deposit' },
  } as unknown as Parameters<typeof activateClientProductFromWebQuotePayment>[0];

  it('role=deposit: flips WebQuote to deposit_paid but leaves ClientProduct untouched', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce({
      id: 'cp_1', clientId: 'c1', productId: 'p1', tenantId: 't1', status: 'quote_pending', product: { code: 'web' },
    });
    mockState.findUniqueWebQuote.mockResolvedValueOnce({ id: 'wq_1', status: 'invoiced_deposit' });

    await activateClientProductFromWebQuotePayment(DEPOSIT_INVOICE);

    expect(mockState.clientProductUpdate).not.toHaveBeenCalled();
    expect(mockState.webQuoteUpdate).toHaveBeenCalledWith({ where: { id: 'wq_1' }, data: { status: 'deposit_paid' } });
    expect(mockState.webQuoteAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'deposit_paid' }) }),
    );
  });

  it('role=deposit: is a no-op when the WebQuote is not invoiced_deposit (idempotent)', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce({
      id: 'cp_1', clientId: 'c1', productId: 'p1', tenantId: 't1', status: 'quote_pending', product: { code: 'web' },
    });
    mockState.findUniqueWebQuote.mockResolvedValueOnce({ id: 'wq_1', status: 'deposit_paid' });

    await activateClientProductFromWebQuotePayment(DEPOSIT_INVOICE);

    expect(mockState.webQuoteUpdate).not.toHaveBeenCalled();
  });

  it('role=final: activates the ClientProduct exactly like role=full', async () => {
    const FINAL_INVOICE = {
      metadata: { kairikos_client_product_id: 'cp_1', kairikos_invoice_role: 'final' },
    } as unknown as Parameters<typeof activateClientProductFromWebQuotePayment>[0];
    mockState.findUniqueClientProduct.mockResolvedValueOnce({
      id: 'cp_1', clientId: 'c1', productId: 'p1', tenantId: 't1', status: 'quote_pending', product: { code: 'web' },
    });
    mockState.findUniqueWebQuote.mockResolvedValueOnce({ id: 'wq_1', status: 'invoiced_final' });
    mockState.clientProductUpdate.mockResolvedValueOnce({ id: 'cp_1', clientId: 'c1', productId: 'p1', tenantId: 't1' });

    await activateClientProductFromWebQuotePayment(FINAL_INVOICE);

    expect(mockState.clientProductUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cp_1' }, data: expect.objectContaining({ status: 'active' }) }),
    );
    expect(mockState.webQuoteUpdate).toHaveBeenCalledWith({ where: { id: 'wq_1' }, data: { status: 'paid' } });
  });
});

describe('voidWebQuoteInvoice', () => {
  const INVOICE = { id: 'inv_1', stripeId: 'in_stripe_1', status: 'open' };

  it('returns invoice_not_found when the invoice does not exist', async () => {
    mockState.findUniqueInvoice.mockResolvedValueOnce(null);
    const result = await voidWebQuoteInvoice({ invoiceId: 'inv_missing' });
    expect(result).toEqual({ ok: false, error: { kind: 'invoice_not_found' } });
    expect(mockState.invoicesVoid).not.toHaveBeenCalled();
  });

  it('returns already_paid without calling Stripe when the invoice is already paid', async () => {
    mockState.findUniqueInvoice.mockResolvedValueOnce({ ...INVOICE, status: 'paid' });
    const result = await voidWebQuoteInvoice({ invoiceId: 'inv_1' });
    expect(result).toEqual({ ok: false, error: { kind: 'already_paid' } });
    expect(mockState.invoicesVoid).not.toHaveBeenCalled();
  });

  it('voids via Stripe and syncs the local mirror immediately on the happy path', async () => {
    mockState.findUniqueInvoice.mockResolvedValueOnce(INVOICE);
    mockState.invoicesVoid.mockResolvedValueOnce({
      id: 'in_stripe_1',
      status: 'void',
      metadata: { kairikos_client_product_id: 'cp_1' },
    });
    mockState.findUniqueClientProduct.mockResolvedValueOnce({ id: 'cp_1', tenantId: 't1', clientId: 'c1' });
    mockState.invoiceUpsert.mockResolvedValueOnce({});

    const result = await voidWebQuoteInvoice({ invoiceId: 'inv_1' });

    expect(result).toEqual({ ok: true });
    expect(mockState.invoicesVoid).toHaveBeenCalledWith('in_stripe_1');
    expect(mockState.invoiceUpsert).toHaveBeenCalledTimes(1);
    expect(mockState.invoiceUpsert.mock.calls[0][0].create.status).toBe('void');
  });

  it('returns stripe_error when Stripe rejects the void call', async () => {
    mockState.findUniqueInvoice.mockResolvedValueOnce(INVOICE);
    mockState.invoicesVoid.mockRejectedValueOnce(new Error('invoice already paid'));

    const result = await voidWebQuoteInvoice({ invoiceId: 'inv_1' });

    expect(result).toEqual({ ok: false, error: { kind: 'stripe_error', detail: 'invoice already paid' } });
  });
});

describe('syncInvoiceFromStripe — regression: never writes manual-payment columns', () => {
  it('the create/update payloads passed to prisma.invoice.upsert never include paymentChannel/paymentReference/paidOutOfBand/markedPaidBy*', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce({ id: 'cp_1', tenantId: 't1', clientId: 'c1' });
    mockState.invoiceUpsert.mockResolvedValueOnce({});

    await syncInvoiceFromStripe({
      id: 'in_1',
      status: 'paid',
      amount_due: 99900,
      amount_paid: 99900,
      currency: 'eur',
      created: 1700000000,
      metadata: { kairikos_client_product_id: 'cp_1' },
    } as never);

    expect(mockState.invoiceUpsert).toHaveBeenCalledTimes(1);
    const call = mockState.invoiceUpsert.mock.calls[0][0];
    const forbiddenKeys = ['paymentChannel', 'paymentReference', 'paidOutOfBand', 'markedPaidByOperatorId', 'markedPaidAt'];
    for (const key of forbiddenKeys) {
      expect(Object.keys(call.create)).not.toContain(key);
      expect(Object.keys(call.update)).not.toContain(key);
    }
  });

  it('persists invoiceRole from metadata.kairikos_invoice_role in both create and update', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce({ id: 'cp_1', tenantId: 't1', clientId: 'c1' });
    mockState.invoiceUpsert.mockResolvedValueOnce({});

    await syncInvoiceFromStripe({
      id: 'in_1',
      status: 'open',
      amount_due: 87500,
      amount_paid: 0,
      currency: 'eur',
      created: 1700000000,
      metadata: { kairikos_client_product_id: 'cp_1', kairikos_invoice_role: 'deposit' },
    } as never);

    const call = mockState.invoiceUpsert.mock.calls[0][0];
    expect(call.create.invoiceRole).toBe('deposit');
    expect(call.update.invoiceRole).toBe('deposit');
  });

  it('invoiceRole is null when the invoice has no kairikos_invoice_role metadata', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce({ id: 'cp_1', tenantId: 't1', clientId: 'c1' });
    mockState.invoiceUpsert.mockResolvedValueOnce({});

    await syncInvoiceFromStripe({
      id: 'in_1',
      status: 'open',
      amount_due: 87500,
      amount_paid: 0,
      currency: 'eur',
      created: 1700000000,
      metadata: { kairikos_client_product_id: 'cp_1' },
    } as never);

    const call = mockState.invoiceUpsert.mock.calls[0][0];
    expect(call.create.invoiceRole).toBeNull();
  });
});
