// =============================================================================
// KAIA-4262 / WP-19 — unit tests for src/lib/stripe-webhook.ts.
//
// WP-19 replaced the hand-rolled HMAC-SHA256 signature check with the
// Stripe SDK's own `stripe.webhooks.constructEvent`. These tests mock
// that one call (accept → return the parsed event; reject → throw, same
// as the real SDK does on a bad signature) and exercise the REAL
// `handleStripeEvent` end to end — idempotency, dispatch routing, and
// the error-response shape — rather than re-implementing crypto in the
// test file the way the pre-WP-19 version of this file did.
//
// "Recorded events" per the WP-19 AC: one realistic event fixture per
// product-billing shape — a recurring subscription, a subscription-
// linked invoice, and a one-time-purchase invoice with NO subscription
// at all (WP-19's new path) — shaped like what Stripe actually sends,
// trimmed to the fields the handler reads.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  isStripeConfigured: vi.fn(),
  constructEvent: vi.fn(),
  webhookEventCreate: vi.fn(),
  webhookEventUpdate: vi.fn(),
  syncSubscriptionFromStripe: vi.fn(),
  syncInvoiceFromStripe: vi.fn(),
  deleteSubscriptionFromStripe: vi.fn(),
  activateClientProductFromCheckout: vi.fn(),
  expireClientProductFromCheckout: vi.fn(),
  activateClientProductFromWebQuotePayment: vi.fn(),
  logError: vi.fn(),
  notifyOperatorOfExecutionFailure: vi.fn(),
}));

vi.mock('@/lib/stripe', () => ({
  isStripeConfigured: () => mockState.isStripeConfigured(),
  getStripe: () => ({
    webhooks: { constructEvent: (...args: unknown[]) => mockState.constructEvent(...args) },
  }),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    stripeWebhookEvent: {
      create: (...args: unknown[]) => mockState.webhookEventCreate(...args),
      update: (...args: unknown[]) => mockState.webhookEventUpdate(...args),
    },
  },
}));

vi.mock('@/lib/stripe-billing', () => ({
  syncSubscriptionFromStripe: (...args: unknown[]) => mockState.syncSubscriptionFromStripe(...args),
  syncInvoiceFromStripe: (...args: unknown[]) => mockState.syncInvoiceFromStripe(...args),
  deleteSubscriptionFromStripe: (...args: unknown[]) => mockState.deleteSubscriptionFromStripe(...args),
  activateClientProductFromCheckout: (...args: unknown[]) => mockState.activateClientProductFromCheckout(...args),
  expireClientProductFromCheckout: (...args: unknown[]) => mockState.expireClientProductFromCheckout(...args),
  activateClientProductFromWebQuotePayment: (...args: unknown[]) =>
    mockState.activateClientProductFromWebQuotePayment(...args),
}));

vi.mock('@/lib/observability', () => ({
  logError: (...args: unknown[]) => mockState.logError(...args),
}));

vi.mock('@/lib/operator-notify', () => ({
  notifyOperatorOfExecutionFailure: (...args: unknown[]) => mockState.notifyOperatorOfExecutionFailure(...args),
}));

import { handleStripeEvent } from '@/lib/stripe-webhook';

const RAW_BODY = '{"id":"evt_test_1"}';
const SIG_HEADER = 't=1723600000,v1=deadbeef';

// -----------------------------------------------------------------------------
// Recorded-event fixtures — one per product-billing shape.
// -----------------------------------------------------------------------------

const RECORDED_SUBSCRIPTION_CREATED = {
  id: 'evt_sub_created_1',
  type: 'customer.subscription.created',
  api_version: '2024-06-20',
  data: {
    object: {
      id: 'sub_chatbot_1',
      status: 'active',
      customer: 'cus_1',
      items: { data: [{ price: { id: 'price_recurring_1', unit_amount: 24900, currency: 'eur' } }] },
      metadata: { kairikos_client_product_id: 'cp_chatbot_1' },
    },
  },
};

const RECORDED_INVOICE_PAID_RECURRING = {
  id: 'evt_invoice_paid_1',
  type: 'invoice.paid',
  api_version: '2024-06-20',
  data: {
    object: {
      id: 'in_recurring_1',
      status: 'paid',
      subscription: 'sub_chatbot_1',
      amount_due: 24900,
      amount_paid: 24900,
    },
  },
};

const RECORDED_INVOICE_PAID_ONE_TIME = {
  id: 'evt_invoice_paid_2',
  type: 'invoice.paid',
  api_version: '2024-06-20',
  data: {
    object: {
      id: 'in_one_time_1',
      status: 'paid',
      // WP-19 — no `subscription` field at all: this is exactly the
      // one-time-purchase invoice shape createOneTimeInvoice produces.
      amount_due: 79900,
      amount_paid: 79900,
      metadata: { kairikos_client_product_id: 'cp_web_1' },
    },
  },
};

// WP-XX — a 'web' custom-quote invoice, paid. Same one-time-purchase
// shape as RECORDED_INVOICE_PAID_ONE_TIME (no subscription field) — the
// two are distinguished only by which ClientProduct the metadata points
// at, not by anything in the event payload itself.
const RECORDED_INVOICE_PAID_WEB_QUOTE = {
  id: 'evt_invoice_paid_3',
  type: 'invoice.paid',
  api_version: '2024-06-20',
  data: {
    object: {
      id: 'in_web_quote_1',
      status: 'paid',
      amount_due: 99900,
      amount_paid: 99900,
      metadata: { kairikos_client_product_id: 'cp_web_2', kairikos_web_quote_id: 'wq_1' },
    },
  },
};

const RECORDED_INVOICE_FINALIZED = {
  id: 'evt_invoice_finalized_1',
  type: 'invoice.finalized',
  api_version: '2024-06-20',
  data: {
    object: {
      id: 'in_web_quote_1',
      status: 'open',
      amount_due: 99900,
      amount_paid: 0,
      metadata: { kairikos_client_product_id: 'cp_web_2', kairikos_web_quote_id: 'wq_1' },
    },
  },
};

// WebQuote v2 — a voided invoice. voidWebQuoteInvoice already syncs the
// local mirror synchronously right after calling voidInvoice, so the
// webhook's job here is just redundant confirmation, same as the other
// invoice.* events.
const RECORDED_INVOICE_VOIDED = {
  id: 'evt_invoice_voided_1',
  type: 'invoice.voided',
  api_version: '2024-06-20',
  data: {
    object: {
      id: 'in_web_quote_1',
      status: 'void',
      amount_due: 99900,
      amount_paid: 0,
      metadata: { kairikos_client_product_id: 'cp_web_2', kairikos_web_quote_id: 'wq_1' },
    },
  },
};

const RECORDED_SUBSCRIPTION_DELETED = {
  id: 'evt_sub_deleted_1',
  type: 'customer.subscription.deleted',
  api_version: '2024-06-20',
  data: { object: { id: 'sub_chatbot_1' } },
};

// WP-30 — the self-serve checkout flow's Checkout Session lifecycle.
const RECORDED_CHECKOUT_COMPLETED = {
  id: 'evt_checkout_completed_1',
  type: 'checkout.session.completed',
  api_version: '2024-06-20',
  data: {
    object: {
      id: 'cs_test_1',
      mode: 'subscription',
      metadata: { kairikos_client_product_id: 'cp_leads_1' },
    },
  },
};

const RECORDED_CHECKOUT_EXPIRED = {
  id: 'evt_checkout_expired_1',
  type: 'checkout.session.expired',
  api_version: '2024-06-20',
  data: {
    object: {
      id: 'cs_test_2',
      mode: 'payment',
      metadata: { kairikos_client_product_id: 'cp_web_1' },
    },
  },
};

beforeEach(() => {
  mockState.isStripeConfigured.mockReset().mockReturnValue(true);
  mockState.constructEvent.mockReset();
  mockState.webhookEventCreate.mockReset().mockResolvedValue({ eventId: 'evt_test_1' });
  mockState.webhookEventUpdate.mockReset().mockResolvedValue({});
  mockState.syncSubscriptionFromStripe.mockReset().mockResolvedValue(undefined);
  mockState.syncInvoiceFromStripe.mockReset().mockResolvedValue(undefined);
  mockState.deleteSubscriptionFromStripe.mockReset().mockResolvedValue(undefined);
  mockState.activateClientProductFromCheckout.mockReset().mockResolvedValue(undefined);
  mockState.expireClientProductFromCheckout.mockReset().mockResolvedValue(undefined);
  mockState.activateClientProductFromWebQuotePayment.mockReset().mockResolvedValue(undefined);
  mockState.logError.mockReset();
  mockState.notifyOperatorOfExecutionFailure.mockReset().mockResolvedValue(undefined);
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
});

describe('handleStripeEvent — preconditions', () => {
  it('returns 503 when Stripe is not configured', async () => {
    mockState.isStripeConfigured.mockReturnValue(false);
    const result = await handleStripeEvent(RAW_BODY, SIG_HEADER);
    expect(result.statusCode).toBe(503);
    expect(result.body.status).toBe('missing_secret');
    expect(mockState.constructEvent).not.toHaveBeenCalled();
  });

  it('returns 503 when STRIPE_WEBHOOK_SECRET is not set', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const result = await handleStripeEvent(RAW_BODY, SIG_HEADER);
    expect(result.statusCode).toBe(503);
    expect(result.body.status).toBe('missing_secret');
  });

  it('returns 400 when the Stripe-Signature header is missing', async () => {
    const result = await handleStripeEvent(RAW_BODY, null);
    expect(result.statusCode).toBe(400);
    expect(result.body.status).toBe('signature_invalid');
    expect(mockState.constructEvent).not.toHaveBeenCalled();
  });
});

describe('handleStripeEvent — signature verification (via stripe.webhooks.constructEvent)', () => {
  it('returns 400 when constructEvent throws (invalid/tampered signature)', async () => {
    mockState.constructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature for payload');
    });
    const result = await handleStripeEvent(RAW_BODY, SIG_HEADER);
    expect(result.statusCode).toBe(400);
    expect(result.body.status).toBe('signature_invalid');
    expect(mockState.webhookEventCreate).not.toHaveBeenCalled();
  });

  it('passes the raw body, header, secret, and a 300s tolerance through to constructEvent', async () => {
    mockState.constructEvent.mockReturnValue(RECORDED_SUBSCRIPTION_CREATED);
    await handleStripeEvent(RAW_BODY, SIG_HEADER);
    expect(mockState.constructEvent).toHaveBeenCalledWith(RAW_BODY, SIG_HEADER, 'whsec_test_secret', 300);
  });

  it('proceeds to dispatch when constructEvent accepts the signature', async () => {
    mockState.constructEvent.mockReturnValue(RECORDED_SUBSCRIPTION_CREATED);
    const result = await handleStripeEvent(RAW_BODY, SIG_HEADER);
    expect(result.statusCode).toBe(200);
    expect(result.body.status).toBe('ok');
  });
});

describe('handleStripeEvent — idempotency', () => {
  it('returns 200 duplicate without dispatching when the event id was already seen (P2002)', async () => {
    mockState.constructEvent.mockReturnValue(RECORDED_SUBSCRIPTION_CREATED);
    mockState.webhookEventCreate.mockRejectedValueOnce({ code: 'P2002' });
    const result = await handleStripeEvent(RAW_BODY, SIG_HEADER);
    expect(result.statusCode).toBe(200);
    expect(result.body.status).toBe('duplicate');
    expect(mockState.syncSubscriptionFromStripe).not.toHaveBeenCalled();
  });
});

describe('handleStripeEvent — dispatch by recorded event type', () => {
  it('customer.subscription.created → syncSubscriptionFromStripe', async () => {
    mockState.constructEvent.mockReturnValue(RECORDED_SUBSCRIPTION_CREATED);
    const result = await handleStripeEvent(RAW_BODY, SIG_HEADER);
    expect(result.statusCode).toBe(200);
    expect(mockState.syncSubscriptionFromStripe).toHaveBeenCalledWith(
      RECORDED_SUBSCRIPTION_CREATED.data.object,
    );
    expect(mockState.webhookEventUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'processed', appliedTo: 'subscription' }) }),
    );
  });

  it('customer.subscription.deleted → deleteSubscriptionFromStripe', async () => {
    mockState.constructEvent.mockReturnValue(RECORDED_SUBSCRIPTION_DELETED);
    const result = await handleStripeEvent(RAW_BODY, SIG_HEADER);
    expect(result.statusCode).toBe(200);
    expect(mockState.deleteSubscriptionFromStripe).toHaveBeenCalledWith('sub_chatbot_1');
  });

  it('invoice.paid (subscription-linked, recurring product) → syncInvoiceFromStripe', async () => {
    mockState.constructEvent.mockReturnValue(RECORDED_INVOICE_PAID_RECURRING);
    const result = await handleStripeEvent(RAW_BODY, SIG_HEADER);
    expect(result.statusCode).toBe(200);
    expect(mockState.syncInvoiceFromStripe).toHaveBeenCalledWith(
      RECORDED_INVOICE_PAID_RECURRING.data.object,
    );
  });

  it('invoice.paid (WP-19 one-time-purchase, no subscription field) → syncInvoiceFromStripe', async () => {
    mockState.constructEvent.mockReturnValue(RECORDED_INVOICE_PAID_ONE_TIME);
    const result = await handleStripeEvent(RAW_BODY, SIG_HEADER);
    expect(result.statusCode).toBe(200);
    expect(mockState.syncInvoiceFromStripe).toHaveBeenCalledWith(
      RECORDED_INVOICE_PAID_ONE_TIME.data.object,
    );
  });

  it('invoice.paid (WP-XX web quote) → syncInvoiceFromStripe AND activateClientProductFromWebQuotePayment', async () => {
    mockState.constructEvent.mockReturnValue(RECORDED_INVOICE_PAID_WEB_QUOTE);
    const result = await handleStripeEvent(RAW_BODY, SIG_HEADER);
    expect(result.statusCode).toBe(200);
    expect(mockState.syncInvoiceFromStripe).toHaveBeenCalledWith(RECORDED_INVOICE_PAID_WEB_QUOTE.data.object);
    expect(mockState.activateClientProductFromWebQuotePayment).toHaveBeenCalledWith(
      RECORDED_INVOICE_PAID_WEB_QUOTE.data.object,
    );
  });

  it('invoice.finalized does NOT call activateClientProductFromWebQuotePayment (only invoice.paid does)', async () => {
    mockState.constructEvent.mockReturnValue(RECORDED_INVOICE_FINALIZED);
    const result = await handleStripeEvent(RAW_BODY, SIG_HEADER);
    expect(result.statusCode).toBe(200);
    expect(mockState.syncInvoiceFromStripe).toHaveBeenCalledWith(RECORDED_INVOICE_FINALIZED.data.object);
    expect(mockState.activateClientProductFromWebQuotePayment).not.toHaveBeenCalled();
  });

  it('invoice.voided (WebQuote v2) → syncInvoiceFromStripe, no activation', async () => {
    mockState.constructEvent.mockReturnValue(RECORDED_INVOICE_VOIDED);
    const result = await handleStripeEvent(RAW_BODY, SIG_HEADER);
    expect(result.statusCode).toBe(200);
    expect(mockState.syncInvoiceFromStripe).toHaveBeenCalledWith(RECORDED_INVOICE_VOIDED.data.object);
    expect(mockState.activateClientProductFromWebQuotePayment).not.toHaveBeenCalled();
  });

  it('checkout.session.completed (WP-30) → activateClientProductFromCheckout', async () => {
    mockState.constructEvent.mockReturnValue(RECORDED_CHECKOUT_COMPLETED);
    const result = await handleStripeEvent(RAW_BODY, SIG_HEADER);
    expect(result.statusCode).toBe(200);
    expect(mockState.activateClientProductFromCheckout).toHaveBeenCalledWith(
      RECORDED_CHECKOUT_COMPLETED.data.object,
    );
    expect(mockState.webhookEventUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ appliedTo: 'checkout_session' }) }),
    );
  });

  it('checkout.session.expired (WP-30) → expireClientProductFromCheckout', async () => {
    mockState.constructEvent.mockReturnValue(RECORDED_CHECKOUT_EXPIRED);
    const result = await handleStripeEvent(RAW_BODY, SIG_HEADER);
    expect(result.statusCode).toBe(200);
    expect(mockState.expireClientProductFromCheckout).toHaveBeenCalledWith(
      RECORDED_CHECKOUT_EXPIRED.data.object,
    );
  });

  it('an unhandled event type is recorded as ignored, no sync call fires', async () => {
    mockState.constructEvent.mockReturnValue({
      id: 'evt_charge_1',
      type: 'charge.succeeded',
      data: { object: { id: 'ch_1' } },
    });
    const result = await handleStripeEvent(RAW_BODY, SIG_HEADER);
    expect(result.statusCode).toBe(200);
    expect(mockState.syncSubscriptionFromStripe).not.toHaveBeenCalled();
    expect(mockState.syncInvoiceFromStripe).not.toHaveBeenCalled();
    expect(mockState.deleteSubscriptionFromStripe).not.toHaveBeenCalled();
    expect(mockState.webhookEventUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ appliedTo: 'ignored' }) }),
    );
  });
});

describe('handleStripeEvent — handler failure (WP-19 status-body fix)', () => {
  it('returns 500 with status "error" (not "ok") when the handler throws', async () => {
    mockState.constructEvent.mockReturnValue(RECORDED_SUBSCRIPTION_CREATED);
    mockState.syncSubscriptionFromStripe.mockRejectedValueOnce(new Error('db unavailable'));
    const result = await handleStripeEvent(RAW_BODY, SIG_HEADER);
    expect(result.statusCode).toBe(500);
    expect(result.body.status).toBe('error');
    expect(result.body.detail).toContain('db unavailable');
  });

  it('logs the failure and notifies the operator', async () => {
    mockState.constructEvent.mockReturnValue(RECORDED_SUBSCRIPTION_CREATED);
    mockState.syncSubscriptionFromStripe.mockRejectedValueOnce(new Error('db unavailable'));
    await handleStripeEvent(RAW_BODY, SIG_HEADER);
    expect(mockState.logError).toHaveBeenCalledWith(
      'stripe.webhook_handler',
      expect.any(Error),
      expect.objectContaining({ stripeEventId: 'evt_sub_created_1' }),
    );
    expect(mockState.notifyOperatorOfExecutionFailure).toHaveBeenCalledWith(
      expect.objectContaining({ workflowName: 'stripe_webhook:customer.subscription.created' }),
    );
  });

  it('marks the webhook event row as failed', async () => {
    mockState.constructEvent.mockReturnValue(RECORDED_SUBSCRIPTION_CREATED);
    mockState.syncSubscriptionFromStripe.mockRejectedValueOnce(new Error('db unavailable'));
    await handleStripeEvent(RAW_BODY, SIG_HEADER);
    expect(mockState.webhookEventUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
  });
});
