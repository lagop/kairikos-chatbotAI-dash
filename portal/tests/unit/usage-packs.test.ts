// =============================================================================
// Plan de precios del 01/10/2026 — los packs de uso (lib/usage-packs.ts).
//
// Lo que no puede fallar en silencio:
//  - que el cliente cargue saldo a algo que no es suyo (el destino se resuelve
//    contra SU clientId, nunca se acepta tal cual);
//  - que un pago se abone dos veces (webhook repetido) o ninguna;
//  - que se abone sin haberse cobrado.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  resolveContractedInstance: vi.fn(),
  productFindFirst: vi.fn(),
  clientFindUnique: vi.fn(),
  purchaseCreate: vi.fn(),
  purchaseUpdate: vi.fn(),
  purchaseUpdateMany: vi.fn(),
  purchaseFindUniqueOrThrow: vi.fn(),
  usageUpsert: vi.fn(),
  campaignUpdateMany: vi.fn(),
  sessionsCreate: vi.fn(),
  ensureCustomer: vi.fn(),
}));

vi.mock('@/lib/prisma', () => {
  const tx = {
    usagePackPurchase: {
      updateMany: (...a: unknown[]) => mockState.purchaseUpdateMany(...a),
      findUniqueOrThrow: (...a: unknown[]) => mockState.purchaseFindUniqueOrThrow(...a),
    },
    chatbotUsage: { upsert: (...a: unknown[]) => mockState.usageUpsert(...a) },
    prospectingCampaign: { updateMany: (...a: unknown[]) => mockState.campaignUpdateMany(...a) },
  };
  return {
    prisma: {
      product: { findFirst: (...a: unknown[]) => mockState.productFindFirst(...a) },
      chatbotClient: { findUnique: (...a: unknown[]) => mockState.clientFindUnique(...a) },
      usagePackPurchase: {
        create: (...a: unknown[]) => mockState.purchaseCreate(...a),
        update: (...a: unknown[]) => mockState.purchaseUpdate(...a),
        updateMany: (...a: unknown[]) => mockState.purchaseUpdateMany(...a),
      },
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
});
vi.mock('@/lib/stripe', () => ({
  isStripeConfigured: async () => true,
  getStripe: async () => ({ checkout: { sessions: { create: (...a: unknown[]) => mockState.sessionsCreate(...a) } } }),
}));
vi.mock('@/lib/stripe-billing', () => ({ ensureCustomerForTenant: (...a: unknown[]) => mockState.ensureCustomer(...a) }));
vi.mock('@/lib/client-product-access', () => ({
  resolveContractedInstance: (...a: unknown[]) => mockState.resolveContractedInstance(...a),
}));
vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));

import { createUsagePackCheckout, creditUsagePackFromCheckout, expireUsagePackFromCheckout } from '@/lib/usage-packs';
import { packLeadsConsumed } from '@/lib/prospecting';

beforeEach(() => {
  for (const fn of Object.values(mockState)) fn.mockReset();
  mockState.resolveContractedInstance.mockResolvedValue({ clientProductId: 'cp_bot_1', tenantId: 't1' });
  mockState.productFindFirst.mockResolvedValue({
    id: 'prod_pack',
    setupFeeCents: 2900,
    currency: 'EUR',
    stripeSetupPriceId: 'price_pack_live',
  });
  mockState.clientFindUnique.mockResolvedValue({ tenantId: 't1' });
  mockState.ensureCustomer.mockResolvedValue('cus_1');
  mockState.purchaseCreate.mockResolvedValue({ id: 'pur_1' });
  mockState.purchaseUpdate.mockResolvedValue({});
  mockState.sessionsCreate.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' });
});

describe('createUsagePackCheckout', () => {
  it('resuelve el destino contra el cliente de la sesión y abre un pago único del pack', async () => {
    const res = await createUsagePackCheckout({
      clientId: 'c1',
      packCode: 'pack_chatbot_messages',
      targetClientProductId: 'cp_bot_1',
    });

    expect(res).toEqual({ ok: true, url: 'https://checkout.stripe.com/c/pay/cs_1' });
    expect(mockState.resolveContractedInstance).toHaveBeenCalledWith(expect.anything(), {
      clientId: 'c1',
      productCode: 'chatbot',
      clientProductId: 'cp_bot_1',
    });
    expect(mockState.purchaseCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        clientId: 'c1',
        packCode: 'pack_chatbot_messages',
        targetClientProductId: 'cp_bot_1',
        units: 2000,
        amountCents: 2900,
        status: 'pending',
      }),
    });
    expect(mockState.sessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'payment',
        line_items: [{ price: 'price_pack_live', quantity: 1 }],
        metadata: expect.objectContaining({ kairikos_usage_pack_purchase_id: 'pur_1' }),
      }),
    );
    expect(mockState.purchaseUpdate).toHaveBeenCalledWith({
      where: { id: 'pur_1' },
      data: { stripeCheckoutSessionId: 'cs_1' },
    });
  });

  it('un chatbot que no es del cliente no recibe nada', async () => {
    mockState.resolveContractedInstance.mockResolvedValue(null);
    const res = await createUsagePackCheckout({ clientId: 'c1', packCode: 'pack_chatbot_messages', targetClientProductId: 'cp_ajeno' });
    expect(res).toEqual({ ok: false, error: 'target_not_found' });
    expect(mockState.purchaseCreate).not.toHaveBeenCalled();
  });

  it('un pack inventado o aún no creado en Stripe no abre pago', async () => {
    await expect(createUsagePackCheckout({ clientId: 'c1', packCode: 'pack_gratis' })).resolves.toEqual({
      ok: false,
      error: 'unknown_pack',
    });
    mockState.productFindFirst.mockResolvedValue({ id: 'p', setupFeeCents: 3900, currency: 'EUR', stripeSetupPriceId: null });
    await expect(createUsagePackCheckout({ clientId: 'c1', packCode: 'pack_prospecting_leads' })).resolves.toEqual({
      ok: false,
      error: 'pack_not_on_sale',
    });
    expect(mockState.sessionsCreate).not.toHaveBeenCalled();
  });

  it('si Stripe falla, la compra queda caducada, no pendiente para siempre', async () => {
    mockState.sessionsCreate.mockRejectedValue(new Error('stripe down'));
    const res = await createUsagePackCheckout({ clientId: 'c1', packCode: 'pack_chatbot_messages' });
    expect(res).toEqual({ ok: false, error: 'stripe_error' });
    expect(mockState.purchaseUpdate).toHaveBeenCalledWith({ where: { id: 'pur_1' }, data: { status: 'expired' } });
  });
});

describe('creditUsagePackFromCheckout', () => {
  const session = (over: Record<string, unknown> = {}) =>
    ({
      id: 'cs_1',
      payment_status: 'paid',
      metadata: { kairikos_usage_pack_purchase_id: 'pur_1' },
      ...over,
    }) as never;

  it('suma los mensajes al chatbot y rearma el aviso de tope', async () => {
    mockState.purchaseUpdateMany.mockResolvedValue({ count: 1 });
    mockState.purchaseFindUniqueOrThrow.mockResolvedValue({
      packCode: 'pack_chatbot_messages',
      targetClientProductId: 'cp_bot_1',
      clientId: 'c1',
      tenantId: 't1',
      units: 2000,
    });

    await creditUsagePackFromCheckout(session());

    expect(mockState.purchaseUpdateMany).toHaveBeenCalledWith({
      where: { id: 'pur_1', status: 'pending' },
      data: expect.objectContaining({ status: 'credited' }),
    });
    expect(mockState.usageUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clientProductId: 'cp_bot_1' },
        update: { packMessagesRemaining: { increment: 2000 }, capAlertedAt: null },
      }),
    );
  });

  it('un webhook repetido no suma dos veces', async () => {
    mockState.purchaseUpdateMany.mockResolvedValue({ count: 0 });
    await creditUsagePackFromCheckout(session());
    expect(mockState.usageUpsert).not.toHaveBeenCalled();
    expect(mockState.campaignUpdateMany).not.toHaveBeenCalled();
  });

  it('sin cobro confirmado no se abona nada', async () => {
    await creditUsagePackFromCheckout(session({ payment_status: 'unpaid' }));
    expect(mockState.purchaseUpdateMany).not.toHaveBeenCalled();
  });

  it('una sesión que no es de un pack (una contratación) se ignora', async () => {
    await creditUsagePackFromCheckout(session({ metadata: { kairikos_client_product_id: 'cp_x' } }));
    expect(mockState.purchaseUpdateMany).not.toHaveBeenCalled();
  });

  it('suma negocios a la campaña; si la campaña no existe, falla para que Stripe reintente', async () => {
    mockState.purchaseUpdateMany.mockResolvedValue({ count: 1 });
    mockState.purchaseFindUniqueOrThrow.mockResolvedValue({
      packCode: 'pack_prospecting_leads',
      targetClientProductId: 'cp_pros',
      clientId: 'c1',
      tenantId: 't1',
      units: 100,
    });
    mockState.campaignUpdateMany.mockResolvedValueOnce({ count: 1 });
    await creditUsagePackFromCheckout(session());
    expect(mockState.campaignUpdateMany).toHaveBeenCalledWith({
      where: { clientProductId: 'cp_pros' },
      data: { packLeadsRemaining: { increment: 100 }, alertedAt: null },
    });

    mockState.campaignUpdateMany.mockResolvedValueOnce({ count: 0 });
    await expect(creditUsagePackFromCheckout(session())).rejects.toThrow('prospecting_campaign_not_found');
  });

  it('un pago abandonado deja la compra caducada', async () => {
    await expireUsagePackFromCheckout(session());
    expect(mockState.purchaseUpdateMany).toHaveBeenCalledWith({
      where: { id: 'pur_1', status: 'pending' },
      data: { status: 'expired' },
    });
  });
});

describe('packLeadsConsumed — lo que una pasada de prospección gasta del pack', () => {
  it('dentro del cupo no gasta pack', () => {
    expect(packLeadsConsumed(40, 90, 100)).toBe(0);
  });
  it('una pasada que cruza el cupo gasta solo lo que pasa de él', () => {
    expect(packLeadsConsumed(90, 130, 100)).toBe(30);
  });
  it('ya por encima del cupo, todo sale del pack', () => {
    expect(packLeadsConsumed(130, 150, 100)).toBe(20);
  });
});
