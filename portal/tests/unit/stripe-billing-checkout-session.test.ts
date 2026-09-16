// =============================================================================
// createProductCheckoutSession (src/lib/stripe-billing.ts) — unit tests.
//
// Extraído de POST /api/portal/billing/checkout (WP-30) al refactorizar
// esa ruta para que sea un wrapper fino sobre esta función, con
// POST /api/admin/portal/clients como segundo llamante (alta manual de
// operador, enlace de pago para un cliente sin sesión propia). Este
// fichero hereda los fixtures y la mayoría de los casos de
// tests/unit/portal-billing-checkout-route.test.ts — esa suite ahora
// solo cubre lo que sigue siendo responsabilidad de la ruta (sesión,
// validación del body, mapeo de estado HTTP).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  isProductContracted: vi.fn(),
  findUniqueProduct: vi.fn(),
  findUniqueClient: vi.fn(),
  findFirstClientProduct: vi.fn(),
  findUniqueTenant: vi.fn(),
  clientProductCreate: vi.fn(),
  clientProductUpdate: vi.fn(),
  clientProductAuditCreate: vi.fn(),
  isStripeConfigured: vi.fn(),
  checkoutSessionsCreate: vi.fn(),
}));

const mockTx = {
  clientProduct: {
    create: (...args: unknown[]) => mockState.clientProductCreate(...args),
    update: (...args: unknown[]) => mockState.clientProductUpdate(...args),
  },
  clientProductAudit: {
    create: (...args: unknown[]) => mockState.clientProductAuditCreate(...args),
  },
};

vi.mock('@/lib/client-product-access', () => ({
  isProductContracted: (...args: unknown[]) => mockState.isProductContracted(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
    product: { findUnique: (...args: unknown[]) => mockState.findUniqueProduct(...args) },
    chatbotClient: { findUnique: (...args: unknown[]) => mockState.findUniqueClient(...args) },
    clientProduct: { findFirst: (...args: unknown[]) => mockState.findFirstClientProduct(...args) },
    // ensureCustomerForTenant vive en el MISMO módulo que la función
    // bajo prueba y createProductCheckoutSession la llama como
    // referencia local, no a través del objeto de exportaciones — un
    // vi.mock('@/lib/stripe-billing', ...) parcial nunca interceptaría
    // esa llamada interna. Se deja correr de verdad y se le da un
    // tenant con stripeCustomerId ya puesto para que tome su propio
    // atajo (`if (tenant.stripeCustomerId) return ...`) sin tocar Stripe.
    tenant: { findUnique: (...args: unknown[]) => mockState.findUniqueTenant(...args) },
  },
  isDatabaseConfigured: true,
}));

vi.mock('@/lib/stripe', () => ({
  isStripeConfigured: () => mockState.isStripeConfigured(),
  getStripe: () => ({
    checkout: { sessions: { create: (...args: unknown[]) => mockState.checkoutSessionsCreate(...args) } },
  }),
  StripeUnavailableError: class StripeUnavailableError extends Error {},
}));

const RECURRING_PRODUCT = {
  id: '11111111-1111-1111-1111-111111111111',
  code: 'seo',
  tier: 'standard',
  isActive: true,
  stripeRecurringPriceId: 'price_recurring_1',
  stripeSetupPriceId: null,
  setupFeeCents: 0,
  priceCents: 19900,
  currency: 'EUR',
};
const ONE_TIME_PRODUCT = {
  id: '22222222-2222-2222-2222-222222222222',
  code: 'onetime-test',
  tier: 'standard',
  isActive: true,
  stripeRecurringPriceId: null,
  stripeSetupPriceId: 'price_setup_web_1',
  setupFeeCents: 79900,
  priceCents: 0,
  currency: 'EUR',
};

const ACTOR_ID = 'client:client_1';

beforeEach(() => {
  mockState.isProductContracted.mockReset().mockResolvedValue(false);
  mockState.findUniqueProduct.mockReset().mockResolvedValue(RECURRING_PRODUCT);
  mockState.findUniqueClient.mockReset().mockResolvedValue({ id: 'client_1', tenantId: 'tenant_1' });
  mockState.findFirstClientProduct.mockReset().mockResolvedValue(null);
  mockState.findUniqueTenant.mockReset().mockResolvedValue({ id: 'tenant_1', stripeCustomerId: 'cus_123', name: 'Test', slug: 'test' });
  mockState.clientProductCreate.mockReset().mockResolvedValue({ id: 'cp_1' });
  mockState.clientProductUpdate.mockReset().mockResolvedValue({ id: 'cp_1', status: 'cancelled' });
  mockState.clientProductAuditCreate.mockReset();
  mockState.isStripeConfigured.mockReset().mockReturnValue(true);
  mockState.checkoutSessionsCreate.mockReset().mockResolvedValue({ url: 'https://checkout.stripe.com/pay/cs_test_1' });
});

describe('createProductCheckoutSession — guards', () => {
  it('rejects with already_contracted when the client already has the product active', async () => {
    mockState.isProductContracted.mockResolvedValueOnce(true);
    const { createProductCheckoutSession } = await import('@/lib/stripe-billing');
    const result = await createProductCheckoutSession({ clientId: 'client_1', productId: RECURRING_PRODUCT.id, actorId: ACTOR_ID });
    expect(result).toEqual({ ok: false, error: 'already_contracted' });
    expect(mockState.clientProductCreate).not.toHaveBeenCalled();
    expect(mockState.checkoutSessionsCreate).not.toHaveBeenCalled();
  });

  it('rejects with requires_chatbot for leads when the client does not have chatbot active', async () => {
    mockState.findUniqueProduct.mockResolvedValueOnce({ ...RECURRING_PRODUCT, code: 'leads' });
    const { createProductCheckoutSession } = await import('@/lib/stripe-billing');
    const result = await createProductCheckoutSession({ clientId: 'client_1', productId: RECURRING_PRODUCT.id, actorId: ACTOR_ID });
    expect(result).toEqual({ ok: false, error: 'requires_chatbot' });
    expect(mockState.clientProductCreate).not.toHaveBeenCalled();
    expect(mockState.checkoutSessionsCreate).not.toHaveBeenCalled();
  });

  it('allows leads checkout when the client already has chatbot active', async () => {
    mockState.findUniqueProduct.mockResolvedValueOnce({ ...RECURRING_PRODUCT, code: 'leads' });
    mockState.isProductContracted.mockImplementation((_p: unknown, _c: unknown, code: string) =>
      Promise.resolve(code === 'chatbot'),
    );
    const { createProductCheckoutSession } = await import('@/lib/stripe-billing');
    const result = await createProductCheckoutSession({ clientId: 'client_1', productId: RECURRING_PRODUCT.id, actorId: ACTOR_ID });
    expect(result.ok).toBe(true);
    expect(mockState.checkoutSessionsCreate).toHaveBeenCalled();
  });

  it('rejects with product_not_found for an inactive or missing product', async () => {
    mockState.findUniqueProduct.mockResolvedValueOnce({ ...RECURRING_PRODUCT, isActive: false });
    const { createProductCheckoutSession } = await import('@/lib/stripe-billing');
    const result = await createProductCheckoutSession({ clientId: 'client_1', productId: RECURRING_PRODUCT.id, actorId: ACTOR_ID });
    expect(result).toEqual({ ok: false, error: 'product_not_found' });
  });

  it("rejects with product_requires_quote for code='web' — no longer sells at a fixed price", async () => {
    mockState.findUniqueProduct.mockResolvedValueOnce({ ...ONE_TIME_PRODUCT, code: 'web' });
    const { createProductCheckoutSession } = await import('@/lib/stripe-billing');
    const result = await createProductCheckoutSession({ clientId: 'client_1', productId: ONE_TIME_PRODUCT.id, actorId: ACTOR_ID });
    expect(result).toEqual({ ok: false, error: 'product_requires_quote' });
    expect(mockState.clientProductCreate).not.toHaveBeenCalled();
    expect(mockState.checkoutSessionsCreate).not.toHaveBeenCalled();
  });

  it('rejects with product_price_id_missing when a one-time-only product has neither recurring price nor setup fee provisioned', async () => {
    mockState.findUniqueProduct.mockResolvedValueOnce({ ...ONE_TIME_PRODUCT, stripeSetupPriceId: null, setupFeeCents: 0 });
    const { createProductCheckoutSession } = await import('@/lib/stripe-billing');
    const result = await createProductCheckoutSession({ clientId: 'client_1', productId: ONE_TIME_PRODUCT.id, actorId: ACTOR_ID });
    expect(result).toMatchObject({ ok: false, error: 'product_price_id_missing' });
  });
});

describe('createProductCheckoutSession — ClientProduct pre-creation', () => {
  it('creates a pending_payment ClientProduct and writes a checkout_started audit row before calling Stripe', async () => {
    const { createProductCheckoutSession } = await import('@/lib/stripe-billing');
    const result = await createProductCheckoutSession({ clientId: 'client_1', productId: RECURRING_PRODUCT.id, actorId: ACTOR_ID });

    expect(result.ok).toBe(true);
    expect(mockState.findFirstClientProduct).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clientId: 'client_1', productId: RECURRING_PRODUCT.id } }),
    );
    expect(mockState.clientProductCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'pending_payment' }) }),
    );
    expect(mockState.clientProductAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        clientProductId: 'cp_1',
        action: 'checkout_started',
        statusAfter: 'pending_payment',
        actorId: ACTOR_ID,
      }),
    });
  });

  it('embeds kairikos_client_product_id in the Checkout Session metadata from creation, before Stripe is ever called', async () => {
    const { createProductCheckoutSession } = await import('@/lib/stripe-billing');
    await createProductCheckoutSession({ clientId: 'client_1', productId: RECURRING_PRODUCT.id, actorId: ACTOR_ID });

    const createCallIndex = mockState.clientProductCreate.mock.invocationCallOrder[0];
    const stripeCallIndex = mockState.checkoutSessionsCreate.mock.invocationCallOrder[0];
    expect(createCallIndex).toBeLessThan(stripeCallIndex);

    expect(mockState.checkoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ kairikos_client_product_id: 'cp_1' }),
        subscription_data: expect.objectContaining({
          metadata: expect.objectContaining({ kairikos_client_product_id: 'cp_1' }),
        }),
      }),
    );
  });
});

describe('createProductCheckoutSession — session mode branching', () => {
  it('creates a subscription-mode session with just the recurring line item when there is no setup fee', async () => {
    const { createProductCheckoutSession } = await import('@/lib/stripe-billing');
    await createProductCheckoutSession({ clientId: 'client_1', productId: RECURRING_PRODUCT.id, actorId: ACTOR_ID });

    expect(mockState.checkoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'subscription', line_items: [{ price: 'price_recurring_1', quantity: 1 }] }),
    );
  });

  // 2026-09-16 — sin esto, los códigos que anulan el alta
  // (stripe-promotions.ts) existen en Stripe pero el cliente no tiene
  // dónde escribirlos.
  it('muestra la casilla de código promocional en el pago de una suscripción', async () => {
    const { createProductCheckoutSession } = await import('@/lib/stripe-billing');
    await createProductCheckoutSession({ clientId: 'client_1', productId: RECURRING_PRODUCT.id, actorId: ACTOR_ID });

    expect(mockState.checkoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'subscription', allow_promotion_codes: true }),
    );
  });

  it('adds the one-time setup price as a second line item in subscription mode when present', async () => {
    mockState.findUniqueProduct.mockResolvedValueOnce({ ...RECURRING_PRODUCT, stripeSetupPriceId: 'price_setup_1', setupFeeCents: 9900 });
    const { createProductCheckoutSession } = await import('@/lib/stripe-billing');
    await createProductCheckoutSession({ clientId: 'client_1', productId: RECURRING_PRODUCT.id, actorId: ACTOR_ID });

    expect(mockState.checkoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'subscription',
        line_items: [
          { price: 'price_recurring_1', quantity: 1 },
          { price: 'price_setup_1', quantity: 1 },
        ],
      }),
    );
  });

  it('creates a payment-mode session with invoice_creation enabled for a one-time-only product', async () => {
    mockState.findUniqueProduct.mockResolvedValueOnce(ONE_TIME_PRODUCT);
    const { createProductCheckoutSession } = await import('@/lib/stripe-billing');
    const result = await createProductCheckoutSession({ clientId: 'client_1', productId: ONE_TIME_PRODUCT.id, actorId: ACTOR_ID });

    expect(result.ok).toBe(true);
    expect(mockState.checkoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'payment',
        line_items: [{ price: 'price_setup_web_1', quantity: 1 }],
        invoice_creation: expect.objectContaining({
          enabled: true,
          invoice_data: expect.objectContaining({ metadata: expect.objectContaining({ kairikos_client_product_id: 'cp_1' }) }),
        }),
      }),
    );
  });
});

describe('createProductCheckoutSession — Stripe failure rollback', () => {
  it('reverts the ClientProduct and writes a checkout_failed audit row when session creation throws', async () => {
    mockState.checkoutSessionsCreate.mockRejectedValueOnce(new Error('stripe_down'));
    const { createProductCheckoutSession } = await import('@/lib/stripe-billing');
    const result = await createProductCheckoutSession({ clientId: 'client_1', productId: RECURRING_PRODUCT.id, actorId: ACTOR_ID });

    expect(result).toEqual({ ok: false, error: 'stripe_error' });
    expect(mockState.clientProductUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cp_1' }, data: expect.objectContaining({ status: 'cancelled' }) }),
    );
    expect(mockState.clientProductAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'checkout_failed', statusBefore: 'pending_payment' }),
    });
  });

  it('reverts to the prior status (not cancelled) when the ClientProduct already existed before this attempt', async () => {
    mockState.findFirstClientProduct.mockResolvedValueOnce({ id: 'cp_1', status: 'paused' });
    mockState.checkoutSessionsCreate.mockRejectedValueOnce(new Error('stripe_down'));
    mockState.clientProductUpdate.mockResolvedValueOnce({ id: 'cp_1', status: 'paused' });
    const { createProductCheckoutSession } = await import('@/lib/stripe-billing');
    await createProductCheckoutSession({ clientId: 'client_1', productId: RECURRING_PRODUCT.id, actorId: ACTOR_ID });

    expect(mockState.clientProductUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'paused', cancelledAt: null }) }),
    );
  });
});
