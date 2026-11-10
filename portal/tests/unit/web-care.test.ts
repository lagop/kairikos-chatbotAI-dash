// =============================================================================
// Plan de precios del 01/10/2026 — Cuidado de la web (lib/web-care.ts).
//
// Va POR WEB. Lo que no puede pasar: que se contrate para una web ajena o
// todavía sin pagar, que una web acabe con dos, o que el contrato quede atado
// a otra web distinta de la que lo pidió.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  resolveContractedInstance: vi.fn(),
  assignSiteToNewContract: vi.fn(),
  createProductCheckoutSession: vi.fn(),
  ensureCustomerForTenant: vi.fn(),
  findCustomCareOffer: vi.fn(),
  sessionsCreate: vi.fn(),
}));

vi.mock('@/lib/client-product-access', () => ({
  resolveContractedInstance: (...a: unknown[]) => mockState.resolveContractedInstance(...a),
}));
vi.mock('@/lib/client-site', () => ({
  assignSiteToNewContract: (...a: unknown[]) => mockState.assignSiteToNewContract(...a),
}));
vi.mock('@/lib/stripe-billing', () => ({
  createProductCheckoutSession: (...a: unknown[]) => mockState.createProductCheckoutSession(...a),
  ensureCustomerForTenant: (...a: unknown[]) => mockState.ensureCustomerForTenant(...a),
}));
vi.mock('@/lib/stripe', () => ({
  isStripeConfigured: async () => true,
  getStripe: async () => ({ checkout: { sessions: { create: (...a: unknown[]) => mockState.sessionsCreate(...a) } } }),
}));
vi.mock('@/lib/custom-care', async () => {
  const rules = await vi.importActual<typeof import('@/lib/custom-care-rules')>('@/lib/custom-care-rules');
  return {
    findCustomCareOffer: (...a: unknown[]) => mockState.findCustomCareOffer(...a),
    firstChargeDate: rules.firstChargeDate,
  };
});

import { createCustomCareCheckout, createWebCareCheckout, customCareTrialEnd, getWebCareState } from '@/lib/web-care';

function fakePrisma(opts: { product?: unknown; existing?: unknown } = {}) {
  return {
    product: { findFirst: vi.fn().mockResolvedValue(opts.product === undefined ? { id: 'prod_care', stripeRecurringPriceId: 'price_care' } : opts.product) },
    clientProduct: { findFirst: vi.fn().mockResolvedValue(opts.existing ?? null) },
  };
}

const WEB = { clientProductId: 'cp_web_1', clientId: 'c1', tenantId: 't1', clientSiteId: 'site_1', code: 'web', tier: 'standard', status: 'active' };

beforeEach(() => {
  for (const fn of Object.values(mockState)) fn.mockReset();
  mockState.resolveContractedInstance.mockResolvedValue(WEB);
  mockState.createProductCheckoutSession.mockResolvedValue({ ok: true, url: 'https://checkout.stripe.com/c/pay/x' });
  mockState.findCustomCareOffer.mockResolvedValue(null);
  mockState.ensureCustomerForTenant.mockResolvedValue('cus_1');
  mockState.sessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/custom' });
});

describe('createWebCareCheckout', () => {
  it('se ata a la web de la URL, resuelta contra el cliente, y vuelve a su página', async () => {
    const prisma = fakePrisma();
    const res = await createWebCareCheckout(prisma as never, {
      clientId: 'c1',
      webClientProductId: 'cp_web_1',
      billing: 'annual',
      actorId: 'client:c1',
    });

    expect(res).toEqual({ ok: true, url: 'https://checkout.stripe.com/c/pay/x' });
    expect(mockState.resolveContractedInstance).toHaveBeenCalledWith(prisma, {
      clientId: 'c1',
      productCode: 'web',
      clientProductId: 'cp_web_1',
    });
    expect(mockState.createProductCheckoutSession).toHaveBeenCalledWith({
      clientId: 'c1',
      productId: 'prod_care',
      actorId: 'client:c1',
      billing: 'annual',
      clientSiteId: 'site_1',
      returnPath: '/portal/web/cp_web_1',
    });
  });

  it('una web ajena o sin pagar no tiene Cuidado', async () => {
    mockState.resolveContractedInstance.mockResolvedValue(null);
    const res = await createWebCareCheckout(fakePrisma() as never, {
      clientId: 'c1',
      webClientProductId: 'cp_ajena',
      billing: 'monthly',
      actorId: 'client:c1',
    });
    expect(res).toEqual({ ok: false, error: 'web_not_found' });
    expect(mockState.createProductCheckoutSession).not.toHaveBeenCalled();
  });

  it('una web que ya lo tiene no contrata otro', async () => {
    const res = await createWebCareCheckout(fakePrisma({ existing: { id: 'cp_care_1' } }) as never, {
      clientId: 'c1',
      webClientProductId: 'cp_web_1',
      billing: 'monthly',
      actorId: 'client:c1',
    });
    expect(res).toEqual({ ok: false, error: 'already_contracted' });
  });

  it('sin precio en Stripe no se vende', async () => {
    const res = await createWebCareCheckout(fakePrisma({ product: { id: 'prod_care', stripeRecurringPriceId: null } }) as never, {
      clientId: 'c1',
      webClientProductId: 'cp_web_1',
      billing: 'monthly',
      actorId: 'client:c1',
    });
    expect(res).toEqual({ ok: false, error: 'care_not_on_sale' });
  });

  it('una web antigua sin sitio recibe el suyo antes de atarle el Cuidado', async () => {
    mockState.resolveContractedInstance.mockResolvedValue({ ...WEB, clientSiteId: null });
    mockState.assignSiteToNewContract.mockResolvedValue({ clientSiteId: 'site_nuevo' });
    await createWebCareCheckout(fakePrisma() as never, {
      clientId: 'c1',
      webClientProductId: 'cp_web_1',
      billing: 'monthly',
      actorId: 'client:c1',
    });
    expect(mockState.createProductCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ clientSiteId: 'site_nuevo' }),
    );
  });
});

describe('getWebCareState', () => {
  it('ofrece 29 €/mes y el anual solo si existe en Stripe', async () => {
    const prisma = {
      product: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'prod_care',
          priceCents: 2900,
          currency: 'EUR',
          stripeRecurringPriceId: 'price_care',
          stripeAnnualPriceId: 'price_care_year',
        }),
      },
      clientProduct: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const state = await getWebCareState(prisma as never, 'c1', 'site_1');
    expect(state).toEqual({
      offer: { productId: 'prod_care', priceCents: 2900, annualPriceCents: 29000, currency: 'EUR' },
      contract: null,
      customOffer: null,
    });
  });
});

// =============================================================================
// 11/11/2026 — mantenimiento a medida (lib/custom-care.ts).
// =============================================================================

describe('customCareTrialEnd', () => {
  it('sin meses sin cobrar, Stripe cobra al momento', () => {
    expect(customCareTrialEnd(new Date('2026-11-11T00:00:00Z'), 0)).toBeNull();
  });
  it('12 meses: el mismo día del año que viene', () => {
    expect(customCareTrialEnd(new Date('2026-11-11T00:00:00Z'), 12)?.toISOString()).toBe('2027-11-11T00:00:00.000Z');
  });
  it('24 meses con un 29 de febrero por medio no pasa del límite de Stripe (730 días)', () => {
    const now = new Date('2027-03-01T00:00:00Z');
    const end = customCareTrialEnd(now, 24)!;
    expect((end.getTime() - now.getTime()) / 86_400_000).toBeLessThanOrEqual(729);
  });
});

describe('createCustomCareCheckout', () => {
  const OFFER = { clientProductId: 'cp_offer', priceCents: 8900, trialMonths: 12, currency: 'EUR' };
  function prismaFor(product: unknown = { id: 'prod_care', stripeProductId: 'prod_stripe_care', tier: 'standard' }) {
    return {
      product: { findFirst: vi.fn().mockResolvedValue(product) },
      chatbotClient: { findUnique: vi.fn().mockResolvedValue({ tenantId: 't1' }) },
      clientProductAudit: { create: vi.fn().mockResolvedValue({}) },
    };
  }

  it('cobra el precio pactado, cada mes, desde que acaban los meses sin cobrar, y pide tarjeta', async () => {
    mockState.findCustomCareOffer.mockResolvedValue(OFFER);
    const prisma = prismaFor();
    const res = await createCustomCareCheckout(prisma as never, {
      clientId: 'c1',
      webClientProductId: 'cp_web_1',
      actorId: 'client:c1',
      now: new Date('2026-11-11T00:00:00Z'),
    });

    expect(res).toEqual({ ok: true, url: 'https://checkout.stripe.com/c/pay/custom' });
    expect(mockState.findCustomCareOffer).toHaveBeenCalledWith(prisma, 'c1', 'site_1');
    const args = mockState.sessionsCreate.mock.calls[0][0];
    expect(args.mode).toBe('subscription');
    expect(args.customer).toBe('cus_1');
    expect(args.line_items).toEqual([
      {
        price_data: { currency: 'eur', product: 'prod_stripe_care', unit_amount: 8900, recurring: { interval: 'month' } },
        quantity: 1,
      },
    ]);
    expect(args.subscription_data.trial_end).toBe(Date.parse('2027-11-11T00:00:00Z') / 1000);
    expect(args.payment_method_collection).toBe('always');
    // El webhook ata la suscripción a la oferta por este id.
    expect(args.subscription_data.metadata.kairikos_client_product_id).toBe('cp_offer');
    expect(args.metadata.kairikos_client_product_id).toBe('cp_offer');
    expect(args.success_url).toMatch(/\/portal\/web\/cp_web_1\?checkout=success$/);
    expect(prisma.clientProductAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ clientProductId: 'cp_offer', action: 'checkout_started' }),
    });
  });

  it('desde el primer mes, sin trial_end', async () => {
    mockState.findCustomCareOffer.mockResolvedValue({ ...OFFER, trialMonths: 0 });
    await createCustomCareCheckout(prismaFor() as never, { clientId: 'c1', webClientProductId: 'cp_web_1', actorId: 'client:c1' });
    expect(mockState.sessionsCreate.mock.calls[0][0].subscription_data).not.toHaveProperty('trial_end');
  });

  it('sin oferta para esa web, offer_not_found (y la ruta cae al Cuidado de catálogo)', async () => {
    const res = await createCustomCareCheckout(prismaFor() as never, { clientId: 'c1', webClientProductId: 'cp_web_1', actorId: 'client:c1' });
    expect(res).toEqual({ ok: false, error: 'offer_not_found' });
    expect(mockState.sessionsCreate).not.toHaveBeenCalled();
  });

  it('una web ajena no llega a buscar oferta', async () => {
    mockState.resolveContractedInstance.mockResolvedValue(null);
    const res = await createCustomCareCheckout(prismaFor() as never, { clientId: 'c1', webClientProductId: 'cp_ajena', actorId: 'client:c1' });
    expect(res).toEqual({ ok: false, error: 'web_not_found' });
    expect(mockState.findCustomCareOffer).not.toHaveBeenCalled();
  });

  it('sin el Cuidado en Stripe, no se vende', async () => {
    mockState.findCustomCareOffer.mockResolvedValue(OFFER);
    const res = await createCustomCareCheckout(prismaFor({ id: 'prod_care', stripeProductId: null, tier: 'standard' }) as never, {
      clientId: 'c1',
      webClientProductId: 'cp_web_1',
      actorId: 'client:c1',
    });
    expect(res).toEqual({ ok: false, error: 'care_not_on_sale' });
  });

  it('si Stripe falla, stripe_error sin lanzar', async () => {
    mockState.findCustomCareOffer.mockResolvedValue(OFFER);
    mockState.sessionsCreate.mockRejectedValue(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await createCustomCareCheckout(prismaFor() as never, { clientId: 'c1', webClientProductId: 'cp_web_1', actorId: 'client:c1' });
    expect(res).toEqual({ ok: false, error: 'stripe_error' });
  });
});
