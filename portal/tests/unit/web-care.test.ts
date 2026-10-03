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
}));

vi.mock('@/lib/client-product-access', () => ({
  resolveContractedInstance: (...a: unknown[]) => mockState.resolveContractedInstance(...a),
}));
vi.mock('@/lib/client-site', () => ({
  assignSiteToNewContract: (...a: unknown[]) => mockState.assignSiteToNewContract(...a),
}));
vi.mock('@/lib/stripe-billing', () => ({
  createProductCheckoutSession: (...a: unknown[]) => mockState.createProductCheckoutSession(...a),
}));

import { createWebCareCheckout, getWebCareState } from '@/lib/web-care';

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
    });
  });
});
