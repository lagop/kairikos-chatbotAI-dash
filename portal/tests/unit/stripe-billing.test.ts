// =============================================================================
// KAIA-4262 / WP-19 — unit tests for src/lib/stripe-billing.ts.
//
// Covers the WP-19 additions specifically:
//   * syncSubscriptionFromStripe now throws explicitly instead of writing
//     an empty-string tenantId when ClientProduct.tenantId is null (the
//     audit's bug #2).
//   * syncInvoiceFromStripe now handles a one-time-purchase invoice (no
//     Stripe subscription at all) by resolving the ClientProduct via
//     metadata, same pattern syncSubscriptionFromStripe already used.
//   * createOneTimeInvoice's Stripe Invoicing API call shape.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  findUniqueClientProduct: vi.fn(),
  findUniqueSubscription: vi.fn(),
  subscriptionUpsert: vi.fn(),
  invoiceUpsert: vi.fn(),
  invoicesCreate: vi.fn(),
  invoiceItemsCreate: vi.fn(),
  invoicesFinalize: vi.fn(),
  clientProductUpdate: vi.fn(),
  clientProductAuditCreate: vi.fn(),
}));

const mockTx = {
  clientProduct: {
    update: (...args: unknown[]) => mockState.clientProductUpdate(...args),
  },
  clientProductAudit: {
    create: (...args: unknown[]) => mockState.clientProductAuditCreate(...args),
  },
};

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
    clientProduct: {
      findUnique: (...args: unknown[]) => mockState.findUniqueClientProduct(...args),
    },
    subscription: {
      findUnique: (...args: unknown[]) => mockState.findUniqueSubscription(...args),
      upsert: (...args: unknown[]) => mockState.subscriptionUpsert(...args),
    },
    invoice: {
      upsert: (...args: unknown[]) => mockState.invoiceUpsert(...args),
    },
  },
}));

vi.mock('@/lib/stripe', () => ({
  isStripeConfigured: () => true,
  getStripe: () => ({
    invoices: {
      create: (...args: unknown[]) => mockState.invoicesCreate(...args),
      finalizeInvoice: (...args: unknown[]) => mockState.invoicesFinalize(...args),
    },
    invoiceItems: {
      create: (...args: unknown[]) => mockState.invoiceItemsCreate(...args),
    },
  }),
  StripeUnavailableError: class StripeUnavailableError extends Error {},
}));

import {
  syncSubscriptionFromStripe,
  syncInvoiceFromStripe,
  createOneTimeInvoice,
  toDate,
  activateClientProductFromCheckout,
  expireClientProductFromCheckout,
} from '@/lib/stripe-billing';

beforeEach(() => {
  mockState.findUniqueClientProduct.mockReset();
  mockState.findUniqueSubscription.mockReset();
  mockState.subscriptionUpsert.mockReset().mockResolvedValue({});
  mockState.invoiceUpsert.mockReset().mockResolvedValue({});
  mockState.invoicesCreate.mockReset();
  mockState.invoiceItemsCreate.mockReset();
  mockState.invoicesFinalize.mockReset();
  mockState.clientProductUpdate.mockReset().mockResolvedValue({
    id: 'cp_1',
    clientId: 'client_1',
    productId: 'prod_1',
    tenantId: 'tenant_1',
  });
  mockState.clientProductAuditCreate.mockReset();
});

function makeStripeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_1',
    status: 'active',
    customer: 'cus_1',
    items: { data: [{ price: { id: 'price_1', unit_amount: 24900, currency: 'eur' } }] },
    cancel_at_period_end: false,
    canceled_at: null,
    metadata: { kairikos_client_product_id: 'cp_1' },
    ...overrides,
  } as never;
}

describe('syncSubscriptionFromStripe — tenantId guard (WP-19 bug fix)', () => {
  it('throws explicitly instead of writing an empty-string tenantId when ClientProduct.tenantId is null', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce({
      id: 'cp_1',
      clientId: 'client_1',
      tenantId: null,
      client: { stripeCustomerId: 'cus_1' },
    });

    await expect(syncSubscriptionFromStripe(makeStripeSubscription())).rejects.toThrow(
      'client_product_missing_tenant_id:cp_1',
    );
    expect(mockState.subscriptionUpsert).not.toHaveBeenCalled();
  });

  it('proceeds normally when tenantId is present', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce({
      id: 'cp_1',
      clientId: 'client_1',
      tenantId: 'tenant_1',
      client: { stripeCustomerId: 'cus_1' },
    });

    await syncSubscriptionFromStripe(makeStripeSubscription());
    expect(mockState.subscriptionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ tenantId: 'tenant_1' }),
      }),
    );
  });

  it('throws when the Stripe subscription has no kairikos_client_product_id metadata', async () => {
    await expect(
      syncSubscriptionFromStripe(makeStripeSubscription({ metadata: {} })),
    ).rejects.toThrow('stripe_subscription_missing_kairikos_client_product_id');
  });
});

describe('syncInvoiceFromStripe — subscription-linked path', () => {
  it('resolves tenantId/clientId via the Subscription row and writes subscriptionId', async () => {
    mockState.findUniqueSubscription.mockResolvedValueOnce({
      id: 'sub_row_1',
      tenantId: 'tenant_1',
      clientId: 'client_1',
    });

    await syncInvoiceFromStripe({
      id: 'in_1',
      status: 'paid',
      subscription: 'sub_1',
      amount_due: 24900,
      amount_paid: 24900,
      created: 1723600000,
    } as never);

    expect(mockState.invoiceUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          tenantId: 'tenant_1',
          clientId: 'client_1',
          subscriptionId: 'sub_row_1',
          clientProductId: null,
        }),
      }),
    );
  });

  it('skips (no upsert) when the Subscription row does not exist yet', async () => {
    mockState.findUniqueSubscription.mockResolvedValueOnce(null);
    await syncInvoiceFromStripe({ id: 'in_1', subscription: 'sub_unknown' } as never);
    expect(mockState.invoiceUpsert).not.toHaveBeenCalled();
  });
});

describe('syncInvoiceFromStripe — one-time-purchase path (WP-19)', () => {
  it('resolves tenantId/clientId via ClientProduct metadata when there is no subscription at all', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce({
      id: 'cp_web_1',
      tenantId: 'tenant_1',
      clientId: 'client_1',
    });

    await syncInvoiceFromStripe({
      id: 'in_one_time_1',
      status: 'paid',
      amount_due: 79900,
      amount_paid: 79900,
      created: 1723600000,
      metadata: { kairikos_client_product_id: 'cp_web_1' },
    } as never);

    expect(mockState.findUniqueSubscription).not.toHaveBeenCalled();
    expect(mockState.invoiceUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          tenantId: 'tenant_1',
          clientId: 'client_1',
          subscriptionId: null,
          clientProductId: 'cp_web_1',
        }),
      }),
    );
  });

  it('skips a subscription-less invoice with no kairikos_client_product_id metadata (not ours)', async () => {
    await syncInvoiceFromStripe({ id: 'in_manual_1', status: 'open', metadata: {} } as never);
    expect(mockState.invoiceUpsert).not.toHaveBeenCalled();
    expect(mockState.findUniqueClientProduct).not.toHaveBeenCalled();
  });

  it('throws explicitly when the resolved ClientProduct has no tenantId', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce({
      id: 'cp_web_1',
      tenantId: null,
      clientId: 'client_1',
    });

    await expect(
      syncInvoiceFromStripe({
        id: 'in_one_time_1',
        metadata: { kairikos_client_product_id: 'cp_web_1' },
      } as never),
    ).rejects.toThrow('client_product_missing_tenant_id:cp_web_1');
  });

  it('skips when the resolved ClientProduct no longer exists', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce(null);
    await syncInvoiceFromStripe({
      id: 'in_one_time_1',
      metadata: { kairikos_client_product_id: 'cp_gone' },
    } as never);
    expect(mockState.invoiceUpsert).not.toHaveBeenCalled();
  });
});

describe('createOneTimeInvoice', () => {
  it('creates a draft invoice with send_invoice collection, adds the setup-fee item, and finalizes', async () => {
    mockState.invoicesCreate.mockResolvedValueOnce({ id: 'in_draft_1' });
    mockState.invoiceItemsCreate.mockResolvedValueOnce({ id: 'ii_1' });
    mockState.invoicesFinalize.mockResolvedValueOnce({ id: 'in_draft_1', status: 'open' });

    const result = await createOneTimeInvoice({
      clientProductId: 'cp_web_1',
      stripeCustomerId: 'cus_1',
      stripeSetupPriceId: 'price_setup_web_1',
      metadata: { kairikos_client_product_id: 'cp_web_1' },
    });

    expect(mockState.invoicesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_1',
        collection_method: 'send_invoice',
        auto_advance: false,
        metadata: { kairikos_client_product_id: 'cp_web_1' },
      }),
    );
    expect(mockState.invoiceItemsCreate).toHaveBeenCalledWith({
      customer: 'cus_1',
      invoice: 'in_draft_1',
      price: 'price_setup_web_1',
    });
    expect(mockState.invoicesFinalize).toHaveBeenCalledWith('in_draft_1');
    expect(result).toEqual({ id: 'in_draft_1', status: 'open' });
  });
});

describe('activateClientProductFromCheckout (WP-30)', () => {
  function makeSession(overrides: Record<string, unknown> = {}) {
    return { id: 'cs_1', metadata: { kairikos_client_product_id: 'cp_1' }, ...overrides } as never;
  }

  it('flips a pending_payment ClientProduct to active and writes a checkout_completed audit row', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce({ status: 'pending_payment' });

    await activateClientProductFromCheckout(makeSession());

    expect(mockState.clientProductUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cp_1' }, data: expect.objectContaining({ status: 'active' }) }),
    );
    expect(mockState.clientProductAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        clientProductId: 'cp_1',
        action: 'checkout_completed',
        statusBefore: 'pending_payment',
        statusAfter: 'active',
        actorId: 'stripe:checkout.session.completed',
      }),
    });
  });

  it('is a no-op when the session has no kairikos_client_product_id metadata (not ours)', async () => {
    await activateClientProductFromCheckout(makeSession({ metadata: {} }));
    expect(mockState.findUniqueClientProduct).not.toHaveBeenCalled();
    expect(mockState.clientProductUpdate).not.toHaveBeenCalled();
  });

  it('is a no-op when the ClientProduct is no longer pending_payment (idempotent against duplicate/late delivery)', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce({ status: 'active' });
    await activateClientProductFromCheckout(makeSession());
    expect(mockState.clientProductUpdate).not.toHaveBeenCalled();
  });

  it('is a no-op when the ClientProduct row no longer exists', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce(null);
    await activateClientProductFromCheckout(makeSession());
    expect(mockState.clientProductUpdate).not.toHaveBeenCalled();
  });
});

describe('expireClientProductFromCheckout (WP-30)', () => {
  function makeSession(overrides: Record<string, unknown> = {}) {
    return { id: 'cs_1', metadata: { kairikos_client_product_id: 'cp_1' }, ...overrides } as never;
  }

  it('flips a pending_payment ClientProduct to cancelled and writes a checkout_expired audit row', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce({ status: 'pending_payment' });

    await expireClientProductFromCheckout(makeSession());

    expect(mockState.clientProductUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cp_1' }, data: expect.objectContaining({ status: 'cancelled' }) }),
    );
    expect(mockState.clientProductAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'checkout_expired',
        statusBefore: 'pending_payment',
        statusAfter: 'cancelled',
        actorId: 'stripe:checkout.session.expired',
      }),
    });
  });

  it('does not touch a ClientProduct that already turned active (the completed event won the race)', async () => {
    mockState.findUniqueClientProduct.mockResolvedValueOnce({ status: 'active' });
    await expireClientProductFromCheckout(makeSession());
    expect(mockState.clientProductUpdate).not.toHaveBeenCalled();
  });
});

describe('toDate', () => {
  it('returns null for null/undefined epoch seconds', () => {
    expect(toDate(null)).toBeNull();
    expect(toDate(undefined)).toBeNull();
  });

  it('converts a real epoch-seconds value to a Date', () => {
    expect(toDate(1723600000)).toEqual(new Date(1723600000 * 1000));
  });
});
