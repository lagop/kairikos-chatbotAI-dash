// =============================================================================
// Códigos que anulan el alta — lib/stripe-promotions.ts y sus rutas de admin.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  productFindUnique: vi.fn(),
  productFindMany: vi.fn(),
  operatorFindUnique: vi.fn(),
  auditCreate: vi.fn(),
  couponsCreate: vi.fn(),
  couponsDel: vi.fn(),
  promotionCodesCreate: vi.fn(),
  promotionCodesList: vi.fn(),
  promotionCodesRetrieve: vi.fn(),
  promotionCodesUpdate: vi.fn(),
  isStripeConfigured: vi.fn(),
  authenticateAdminRequest: vi.fn(),
  requireTotpStepUp: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  isDatabaseConfigured: true,
  prisma: {
    product: {
      findUnique: (...a: unknown[]) => mockState.productFindUnique(...a),
      findMany: (...a: unknown[]) => mockState.productFindMany(...a),
    },
    operator: { findUnique: (...a: unknown[]) => mockState.operatorFindUnique(...a) },
    stripeCatalogAudit: { create: (...a: unknown[]) => mockState.auditCreate(...a) },
  },
}));

vi.mock('@/lib/stripe', () => ({
  isStripeConfigured: (...a: unknown[]) => mockState.isStripeConfigured(...a),
  getStripe: async () => ({
    coupons: {
      create: (...a: unknown[]) => mockState.couponsCreate(...a),
      del: (...a: unknown[]) => mockState.couponsDel(...a),
    },
    promotionCodes: {
      create: (...a: unknown[]) => mockState.promotionCodesCreate(...a),
      list: (...a: unknown[]) => mockState.promotionCodesList(...a),
      retrieve: (...a: unknown[]) => mockState.promotionCodesRetrieve(...a),
      update: (...a: unknown[]) => mockState.promotionCodesUpdate(...a),
    },
  }),
}));

vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...a: unknown[]) => mockState.authenticateAdminRequest(...a),
}));
vi.mock('@/lib/operator-totp-stepup', () => ({
  requireTotpStepUp: (...a: unknown[]) => mockState.requireTotpStepUp(...a),
}));
vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

import {
  createSetupFeeWaiverCode,
  listSetupFeeWaiverCodes,
  deactivateSetupFeeWaiverCode,
  normalisePromotionCode,
  couponName,
  SETUP_FEE_WAIVER_KIND,
} from '@/lib/stripe-promotions';
import { GET, POST } from '@/app/api/admin/portal/settings/promotions/route';
import { DELETE } from '@/app/api/admin/portal/settings/promotions/[promotionCodeId]/route';

const PRODUCT_ID = '11111111-1111-1111-1111-111111111111';
const PRODUCT = {
  id: PRODUCT_ID,
  name: 'Chatbot IA — Starter',
  currency: 'EUR',
  setupFeeCents: 39900,
  stripeProductId: 'prod_chatbot_starter',
  stripeSetupPriceId: 'price_setup_starter',
};
const ACTOR = { operatorId: 'op_1', operatorEmail: 'op@kairikos.com' };
const NOW = new Date('2026-09-16T10:00:00Z');
const META = {
  kairikos_kind: SETUP_FEE_WAIVER_KIND,
  kairikos_product_id: PRODUCT_ID,
  kairikos_setup_fee_cents: '39900',
};

function promo(overrides: Record<string, unknown> = {}) {
  return {
    id: 'promo_1',
    code: 'LANZAMIENTO',
    active: true,
    times_redeemed: 2,
    max_redemptions: 50,
    expires_at: null,
    created: Math.floor(NOW.getTime() / 1000),
    metadata: META,
    coupon: { id: 'co_1', amount_off: 39900, metadata: META },
    ...overrides,
  };
}

function req(body?: unknown) {
  return { json: async () => body ?? null } as unknown as NextRequest;
}

beforeEach(() => {
  for (const fn of Object.values(mockState)) fn.mockReset();
  mockState.productFindUnique.mockResolvedValue(PRODUCT);
  mockState.productFindMany.mockResolvedValue([{ id: PRODUCT_ID, name: PRODUCT.name, setupFeeCents: 39900 }]);
  mockState.operatorFindUnique.mockResolvedValue({ email: 'op@kairikos.com' });
  mockState.auditCreate.mockResolvedValue({});
  mockState.couponsCreate.mockResolvedValue({ id: 'co_1', amount_off: 39900, metadata: META });
  mockState.couponsDel.mockResolvedValue({});
  mockState.promotionCodesCreate.mockResolvedValue(promo());
  mockState.promotionCodesList.mockResolvedValue({ data: [promo()] });
  mockState.promotionCodesRetrieve.mockResolvedValue(promo());
  mockState.promotionCodesUpdate.mockResolvedValue(promo({ active: false }));
  mockState.isStripeConfigured.mockResolvedValue(true);
  mockState.authenticateAdminRequest.mockResolvedValue({ ok: true, sessionId: 's1', operatorId: 'op_1' });
  mockState.requireTotpStepUp.mockResolvedValue({ ok: true, operatorId: 'op_1', sessionId: 's1' });
});

describe('normalisePromotionCode / couponName', () => {
  it('pasa a mayúsculas y rechaza lo que no se puede dictar', () => {
    expect(normalisePromotionCode('  lanzamiento-2026 ')).toBe('LANZAMIENTO-2026');
    expect(normalisePromotionCode('ab')).toBeNull();
    expect(normalisePromotionCode('con espacio')).toBeNull();
    expect(normalisePromotionCode('ÑANDÚ')).toBeNull();
  });

  it('el nombre del cupón nunca pasa de los 40 caracteres de Stripe', () => {
    expect(couponName('Chatbot IA — Starter')).toBe('Sin alta · Chatbot IA — Starter');
    const long = couponName('Recuperación de llamadas — Empresa con nombre largo');
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('createSetupFeeWaiverCode', () => {
  it('crea un cupón de una sola vez por el importe del alta, limitado al producto del tier', async () => {
    const expiresAt = new Date('2026-12-31T23:59:59Z');
    const result = await createSetupFeeWaiverCode(
      { productId: PRODUCT_ID, code: 'lanzamiento', expiresAt, maxRedemptions: 50 },
      ACTOR,
      NOW,
    );

    expect(result.ok).toBe(true);
    expect(mockState.couponsCreate).toHaveBeenCalledWith({
      name: 'Sin alta · Chatbot IA — Starter',
      amount_off: 39900,
      currency: 'eur',
      duration: 'once',
      applies_to: { products: ['prod_chatbot_starter'] },
      metadata: META,
    });
    expect(mockState.promotionCodesCreate).toHaveBeenCalledWith({
      coupon: 'co_1',
      code: 'LANZAMIENTO',
      expires_at: Math.floor(expiresAt.getTime() / 1000),
      max_redemptions: 50,
      metadata: META,
    });
    expect(mockState.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        productId: PRODUCT_ID,
        action: 'promotion_code_created',
        actorOperatorId: 'op_1',
        after: expect.objectContaining({ code: 'LANZAMIENTO', amountOffCents: 39900, promotionCodeId: 'promo_1' }),
      }),
    });
  });

  it('sin caducidad ni tope, no manda esos campos', async () => {
    await createSetupFeeWaiverCode({ productId: PRODUCT_ID, code: 'OFERTA' }, ACTOR, NOW);
    const params = mockState.promotionCodesCreate.mock.calls[0][0];
    expect(params).not.toHaveProperty('expires_at');
    expect(params).not.toHaveProperty('max_redemptions');
  });

  it.each([
    ['un producto sin alta', { ...PRODUCT, setupFeeCents: 0, stripeSetupPriceId: null }, 'no_setup_fee'],
    ['un producto sin precios en Stripe', { ...PRODUCT, stripeProductId: null }, 'not_bootstrapped'],
    ['un producto que no existe', null, 'product_not_found'],
  ])('rechaza %s sin tocar Stripe', async (_label, product, error) => {
    mockState.productFindUnique.mockResolvedValue(product);
    await expect(createSetupFeeWaiverCode({ productId: PRODUCT_ID, code: 'OFERTA' }, ACTOR, NOW)).resolves.toEqual({
      ok: false,
      error,
    });
    expect(mockState.couponsCreate).not.toHaveBeenCalled();
  });

  it('rechaza un código mal escrito o una caducidad pasada sin tocar Stripe', async () => {
    await expect(createSetupFeeWaiverCode({ productId: PRODUCT_ID, code: 'no vale' }, ACTOR, NOW)).resolves.toEqual({
      ok: false,
      error: 'invalid_code',
    });
    await expect(
      createSetupFeeWaiverCode({ productId: PRODUCT_ID, code: 'OFERTA', expiresAt: new Date('2026-09-01') }, ACTOR, NOW),
    ).resolves.toEqual({ ok: false, error: 'invalid_expiry' });
    expect(mockState.couponsCreate).not.toHaveBeenCalled();
  });

  it('si el código ya existe, borra el cupón huérfano y lo dice claro', async () => {
    mockState.promotionCodesCreate.mockRejectedValue(new Error('A promotion code with code LANZAMIENTO already exists.'));
    await expect(createSetupFeeWaiverCode({ productId: PRODUCT_ID, code: 'LANZAMIENTO' }, ACTOR, NOW)).resolves.toEqual({
      ok: false,
      error: 'code_already_exists',
    });
    expect(mockState.couponsDel).toHaveBeenCalledWith('co_1');
    expect(mockState.auditCreate).not.toHaveBeenCalled();
  });

  it('un fallo de Stripe al crear el cupón no lanza', async () => {
    mockState.couponsCreate.mockRejectedValue(new Error('boom'));
    await expect(createSetupFeeWaiverCode({ productId: PRODUCT_ID, code: 'OFERTA' }, ACTOR, NOW)).resolves.toMatchObject({
      ok: false,
      error: 'stripe_error',
    });
  });
});

describe('listSetupFeeWaiverCodes', () => {
  it('solo lista los creados desde el portal y marca los desfasados', async () => {
    mockState.promotionCodesList.mockResolvedValue({
      data: [
        promo(),
        promo({ id: 'promo_manual', code: 'MANUAL', metadata: {}, coupon: { id: 'co_x', amount_off: 1000, metadata: {} } }),
        promo({ id: 'promo_old', code: 'VIEJO', active: false, coupon: { id: 'co_2', amount_off: 29900, metadata: META } }),
      ],
    });

    const result = await listSetupFeeWaiverCodes();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.codes.map((c) => c.code)).toEqual(['LANZAMIENTO', 'VIEJO']);
    expect(result.codes[0]).toMatchObject({ productName: 'Chatbot IA — Starter', stale: false, timesRedeemed: 2, maxRedemptions: 50 });
    // El alta del tier pasó a 399 € después de crear un código de 299 €.
    expect(result.codes[1]).toMatchObject({ stale: true, amountOffCents: 29900, currentSetupFeeCents: 39900 });
  });

  it('si Stripe falla, devuelve error en vez de lanzar', async () => {
    mockState.promotionCodesList.mockRejectedValue(new Error('down'));
    await expect(listSetupFeeWaiverCodes()).resolves.toEqual({ ok: false, error: 'stripe_error' });
  });
});

describe('deactivateSetupFeeWaiverCode', () => {
  it('desactiva y deja auditoría', async () => {
    await expect(deactivateSetupFeeWaiverCode('promo_1', ACTOR)).resolves.toEqual({ ok: true });
    expect(mockState.promotionCodesUpdate).toHaveBeenCalledWith('promo_1', { active: false });
    expect(mockState.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'promotion_code_deactivated', productId: PRODUCT_ID }),
    });
  });

  it('no toca un código creado a mano en el Dashboard de Stripe', async () => {
    mockState.promotionCodesRetrieve.mockResolvedValue(promo({ metadata: {} }));
    await expect(deactivateSetupFeeWaiverCode('promo_1', ACTOR)).resolves.toEqual({ ok: false, error: 'not_found' });
    expect(mockState.promotionCodesUpdate).not.toHaveBeenCalled();
  });
});

describe('rutas /api/admin/portal/settings/promotions', () => {
  it('GET y POST exigen sesión de operador', async () => {
    mockState.authenticateAdminRequest.mockResolvedValue({ ok: false });
    expect((await GET(req())).status).toBe(401);
    expect((await POST(req({ productId: PRODUCT_ID, code: 'OFERTA' }))).status).toBe(401);
  });

  it('POST exige TOTP: crear un código es dejar de cobrar dinero', async () => {
    mockState.requireTotpStepUp.mockResolvedValue({ ok: false, status: 403, error: 'totp_step_up_required' });
    const res = await POST(req({ productId: PRODUCT_ID, code: 'OFERTA' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'totp_step_up_required' });
    expect(mockState.couponsCreate).not.toHaveBeenCalled();
  });

  it('POST crea el código; la fecha caduca al final de ese día', async () => {
    const res = await POST(req({ productId: PRODUCT_ID, code: 'oferta', expiresOn: '2099-12-31', maxRedemptions: 10 }));
    expect(res.status).toBe(201);
    expect(mockState.promotionCodesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'OFERTA',
        expires_at: Math.floor(new Date('2099-12-31T23:59:59Z').getTime() / 1000),
        max_redemptions: 10,
      }),
    );
  });

  it('POST traduce los errores de negocio a estados HTTP', async () => {
    mockState.productFindUnique.mockResolvedValue({ ...PRODUCT, setupFeeCents: 0, stripeSetupPriceId: null });
    const res = await POST(req({ productId: PRODUCT_ID, code: 'OFERTA' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'no_setup_fee' });
  });

  it('GET devuelve la lista', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).codes).toHaveLength(1);
  });

  it('DELETE desactiva sin TOTP', async () => {
    const ok = await DELETE(req(), { params: { promotionCodeId: 'promo_1' } });
    expect(ok.status).toBe(200);
    expect(mockState.requireTotpStepUp).not.toHaveBeenCalled();
  });

  it('DELETE rechaza un id con forma rara sin llamar a Stripe', async () => {
    const res = await DELETE(req(), { params: { promotionCodeId: '../coupons' } });
    expect(res.status).toBe(404);
    expect(mockState.promotionCodesRetrieve).not.toHaveBeenCalled();
  });
});
