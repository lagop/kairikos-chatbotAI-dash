// =============================================================================
// Plan de precios del 01/10/2026 — los packs de productos (Oficio, Presencia):
// la regla (lib/combo-packs.ts) y su aplicación en Stripe (lib/pack-discounts.ts).
//
// Lo que no puede fallar: dar el descuento a quien no tiene la combinación,
// quitárselo a quien la tiene, acumular dos packs, o borrar de paso otro
// descuento que la suscripción ya tuviera.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  retrieve: vi.fn(),
  update: vi.fn(),
  couponsCreate: vi.fn(),
}));

vi.mock('@/lib/stripe', () => ({
  getStripe: async () => ({
    subscriptions: {
      retrieve: (...a: unknown[]) => mockState.retrieve(...a),
      update: (...a: unknown[]) => mockState.update(...a),
    },
    coupons: { create: (...a: unknown[]) => mockState.couponsCreate(...a) },
  }),
}));
vi.mock('@/lib/stripe-credentials', () => ({ resolveActiveStripeSecret: async () => ({ mode: 'live' }) }));
vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));

import { packCouponAmountCents, packPricing, qualifyingPack } from '@/lib/combo-packs';
import { createPackCoupons, nextDiscounts, syncPackDiscounts } from '@/lib/pack-discounts';

const P = (code: string, tier = 'standard') => ({ code, tier });

describe('qualifyingPack', () => {
  it('Oficio: Llamadas Autónomo + Reseñas Basic', () => {
    expect(qualifyingPack([P('recall', 'solo'), P('reviews', 'basic')])).toBe('oficio');
  });

  it('Llamadas Equipo no es el Pack Oficio', () => {
    expect(qualifyingPack([P('recall', 'team'), P('reviews', 'basic')])).toBeNull();
  });

  it('Presencia: cualquier web + Cuidado + Reseñas Basic', () => {
    expect(qualifyingPack([P('web'), P('web_care'), P('reviews', 'basic')])).toBe('presencia');
  });

  it('a medias no hay pack', () => {
    expect(qualifyingPack([P('web'), P('reviews', 'basic')])).toBeNull();
    expect(qualifyingPack([P('recall', 'solo')])).toBeNull();
  });

  it('con los dos, gana el de más descuento: no se acumulan', () => {
    expect(qualifyingPack([P('recall', 'solo'), P('web'), P('web_care'), P('reviews', 'basic')])).toBe('oficio');
  });
});

describe('precios', () => {
  const catalogo = [
    { code: 'recall', tier: 'solo', priceCents: 12900, setupFeeCents: 9900 },
    { code: 'reviews', tier: 'basic', priceCents: 9900, setupFeeCents: 0 },
    { code: 'web', tier: 'standard', priceCents: 0, setupFeeCents: 79900 },
    { code: 'web_care', tier: 'standard', priceCents: 2900, setupFeeCents: 0 },
  ];

  it('los del plan: Oficio 228 → 199; Presencia 799 € + 128 → 109', () => {
    expect(packPricing('oficio', catalogo)).toEqual({ monthlyCents: 19900, separateMonthlyCents: 22800, oneTimeCents: 0 });
    expect(packPricing('presencia', catalogo)).toEqual({ monthlyCents: 10900, separateMonthlyCents: 12800, oneTimeCents: 79900 });
  });

  it('sin una pieza en el catálogo, el pack no se anuncia', () => {
    expect(packPricing('presencia', catalogo.filter((r) => r.code !== 'web_care'))).toBeNull();
  });

  it('en una anual, el descuento es el de diez meses', () => {
    expect(packCouponAmountCents('oficio', 'month')).toBe(2900);
    expect(packCouponAmountCents('oficio', 'year')).toBe(29000);
  });
});

describe('nextDiscounts', () => {
  it('conserva los descuentos que no son de packs y cambia solo el del pack', () => {
    const current = [
      { id: 'di_promo', couponId: 'co_promo' },
      { id: 'di_pack', couponId: 'co_oficio' },
    ];
    expect(nextDiscounts(current, new Set(['co_oficio', 'co_presencia']), 'co_presencia')).toEqual([
      { discount: 'di_promo' },
      { coupon: 'co_presencia' },
    ]);
    expect(nextDiscounts(current, new Set(['co_oficio']), null)).toEqual([{ discount: 'di_promo' }]);
  });
});

function makePrisma(opts: { active: Array<{ code: string; tier: string }>; sub?: Record<string, unknown>; coupons?: unknown[] }) {
  return {
    packCoupon: {
      findMany: vi.fn().mockResolvedValue(
        opts.coupons ?? [
          { packCode: 'oficio', interval: 'month', stripeCouponId: 'co_oficio_m' },
          { packCode: 'oficio', interval: 'year', stripeCouponId: 'co_oficio_y' },
        ],
      ),
      create: vi.fn().mockResolvedValue({}),
    },
    clientProduct: {
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) =>
        'subscription' in args.where
          ? [{ clientId: 'c1', subscription: { id: 'sub_row', stripeId: 'sub_1', billingInterval: 'month', packCode: null, ...opts.sub } }]
          : opts.active.map((product) => ({ product })),
      ),
    },
    subscription: { update: vi.fn().mockResolvedValue({}) },
    product: { findFirst: vi.fn().mockResolvedValue({ id: 'prod_reviews_basic', stripeProductId: 'prod_stripe_rb' }) },
    stripeCatalogAudit: { create: vi.fn().mockResolvedValue({}) },
  };
}

beforeEach(() => {
  for (const fn of Object.values(mockState)) fn.mockReset();
  mockState.retrieve.mockResolvedValue({ discounts: [] });
  mockState.update.mockResolvedValue({});
});

describe('syncPackDiscounts', () => {
  it('aplica el cupón del pack a la suscripción de Reseñas Basic y lo apunta', async () => {
    const prisma = makePrisma({ active: [P('recall', 'solo'), P('reviews', 'basic')] });
    const res = await syncPackDiscounts(prisma as never);
    expect(res.applied).toBe(1);
    expect(mockState.update).toHaveBeenCalledWith('sub_1', { discounts: [{ coupon: 'co_oficio_m' }] });
    expect(prisma.subscription.update).toHaveBeenCalledWith({
      where: { id: 'sub_row' },
      data: expect.objectContaining({ packCode: 'oficio' }),
    });
  });

  it('una anual recibe el cupón anual', async () => {
    const prisma = makePrisma({ active: [P('recall', 'solo'), P('reviews', 'basic')], sub: { billingInterval: 'year' } });
    await syncPackDiscounts(prisma as never);
    expect(mockState.update).toHaveBeenCalledWith('sub_1', { discounts: [{ coupon: 'co_oficio_y' }] });
  });

  it('si ya lo tiene, no llama a Stripe', async () => {
    const prisma = makePrisma({ active: [P('recall', 'solo'), P('reviews', 'basic')], sub: { packCode: 'oficio' } });
    await syncPackDiscounts(prisma as never);
    expect(mockState.update).not.toHaveBeenCalled();
  });

  it('si deja de tener la combinación, se le quita, conservando otros descuentos', async () => {
    const prisma = makePrisma({ active: [P('reviews', 'basic')], sub: { packCode: 'oficio' } });
    mockState.retrieve.mockResolvedValue({
      discounts: [
        { id: 'di_otro', coupon: { id: 'co_otro' } },
        { id: 'di_pack', coupon: { id: 'co_oficio_m' } },
      ],
    });
    const res = await syncPackDiscounts(prisma as never);
    expect(res.removed).toBe(1);
    expect(mockState.update).toHaveBeenCalledWith('sub_1', { discounts: [{ discount: 'di_otro' }] });
    expect(prisma.subscription.update).toHaveBeenCalledWith({
      where: { id: 'sub_row' },
      data: { packCode: null, packAppliedAt: null },
    });
  });

  it('sin el cupón creado todavía, no toca nada', async () => {
    const prisma = makePrisma({ active: [P('recall', 'solo'), P('reviews', 'basic')], coupons: [] });
    const res = await syncPackDiscounts(prisma as never);
    expect(res.skippedNoCoupon).toBe(1);
    expect(mockState.update).not.toHaveBeenCalled();
  });
});

describe('createPackCoupons', () => {
  it('crea solo los que faltan, para siempre y limitados a Reseñas Basic', async () => {
    const prisma = makePrisma({ active: [] });
    mockState.couponsCreate.mockImplementation(async (args: { metadata: { kairikos_pack: string; kairikos_interval: string } }) => ({
      id: `co_${args.metadata.kairikos_pack}_${args.metadata.kairikos_interval}`,
    }));
    const res = await createPackCoupons(prisma as never, { operatorId: 'op', operatorEmail: null });

    // Ya existían los dos de Oficio: faltan los dos de Presencia.
    expect(res).toEqual({ ok: true, created: 2, existing: 2 });
    expect(mockState.couponsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        amount_off: 1900,
        currency: 'eur',
        duration: 'forever',
        applies_to: { products: ['prod_stripe_rb'] },
      }),
    );
    expect(mockState.couponsCreate).toHaveBeenCalledWith(expect.objectContaining({ amount_off: 19000 }));
  });
});
