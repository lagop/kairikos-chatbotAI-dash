// =============================================================================
// 11/11/2026 — mantenimiento a medida (lib/custom-care.ts, custom-care-rules.ts).
//
// Lo que no puede pasar: una cuota de 0 € que Stripe facture cada mes, un
// presupuesto sin cuota que no lo diga, dos ofertas vivas para la misma web,
// o una oferta nueva encima de un Cuidado que ya se cobra.
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import { firstChargeDate, maintenanceLine, normalizeMonthlyCents, NO_MAINTENANCE_TEXT } from '@/lib/custom-care-rules';
import { createCustomCareOffer, findCustomCareOffer, withdrawCustomCareOffer } from '@/lib/custom-care';

describe('normalizeMonthlyCents', () => {
  it('vacía, 0 o negativa es sin mantenimiento', () => {
    expect(normalizeMonthlyCents(undefined)).toBeNull();
    expect(normalizeMonthlyCents(null)).toBeNull();
    expect(normalizeMonthlyCents(0)).toBeNull();
    expect(normalizeMonthlyCents(-500)).toBeNull();
    expect(normalizeMonthlyCents(Number.NaN)).toBeNull();
  });
  it('un importe se queda', () => {
    expect(normalizeMonthlyCents(8900)).toBe(8900);
  });
});

describe('firstChargeDate', () => {
  it('suma meses de calendario', () => {
    expect(firstChargeDate(new Date('2026-11-11T10:00:00Z'), 12).toISOString()).toBe('2027-11-11T10:00:00.000Z');
  });
  it('un 31 que no existe en el mes de destino se queda en su último día', () => {
    expect(firstChargeDate(new Date('2027-01-31T00:00:00Z'), 1).toISOString()).toBe('2027-02-28T00:00:00.000Z');
    expect(firstChargeDate(new Date('2027-01-31T00:00:00Z'), 13).toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });
});

describe('maintenanceLine', () => {
  it('sin cuota lo dice, con lo que pasa después', () => {
    expect(maintenanceLine(null, 12, 'eur')).toBe(NO_MAINTENANCE_TEXT);
    expect(NO_MAINTENANCE_TEXT).toMatch(/te entregamos la web/);
  });
  it('con meses incluidos', () => {
    // Intl separa el importe del € con un espacio duro (U+00A0).
    expect(maintenanceLine(8900, 12, 'eur').replace(/ /g, ' ')).toBe(
      'Mantenimiento: 89,00 €/mes. Los 12 primeros meses van incluidos; la cuota empieza a cobrarse después.',
    );
    expect(maintenanceLine(8900, 1, 'eur')).toMatch(/El primer mes va incluido/);
  });
  it('desde el primer mes', () => {
    expect(maintenanceLine(2900, 0, 'eur').replace(/ /g, ' ')).toBe('Mantenimiento: 29,00 €/mes desde el primer mes.');
  });
});

function fakeDb(opts: { product?: unknown; contracted?: unknown; pending?: Array<{ id: string }> } = {}) {
  return {
    product: { findFirst: vi.fn().mockResolvedValue(opts.product === undefined ? { id: 'prod_care' } : opts.product) },
    clientProduct: {
      findFirst: vi.fn().mockResolvedValue(opts.contracted ?? null),
      findMany: vi.fn().mockResolvedValue(opts.pending ?? []),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn().mockResolvedValue({ id: 'cp_offer_new' }),
    },
    clientProductAudit: { create: vi.fn().mockResolvedValue({}) },
  };
}

const INPUT = { clientId: 'c1', tenantId: 't1', clientSiteId: 'site_1', priceCents: 8900, trialMonths: 12, actorId: 'op_1' };

describe('createCustomCareOffer', () => {
  it('crea la oferta pendiente con su precio, sus meses y el sitio de su web', async () => {
    const db = fakeDb();
    const res = await createCustomCareOffer(db as never, INPUT);
    expect(res).toEqual({ ok: true, clientProductId: 'cp_offer_new' });
    expect(db.clientProduct.create).toHaveBeenCalledWith({
      data: {
        clientId: 'c1',
        productId: 'prod_care',
        tenantId: 't1',
        clientSiteId: 'site_1',
        status: 'pending_payment',
        customPriceCents: 8900,
        customTrialMonths: 12,
        createdBy: 'op_1',
      },
    });
    expect(db.clientProductAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ clientProductId: 'cp_offer_new', action: 'custom_care_offered', statusAfter: 'pending_payment' }),
    });
  });

  it('una oferta nueva retira la pendiente de esa web', async () => {
    const db = fakeDb({ pending: [{ id: 'cp_offer_old' }] });
    await createCustomCareOffer(db as never, INPUT);
    expect(db.clientProduct.update).toHaveBeenCalledWith({
      where: { id: 'cp_offer_old' },
      data: expect.objectContaining({ status: 'cancelled' }),
    });
    expect(db.clientProductAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ clientProductId: 'cp_offer_old', action: 'custom_care_replaced' }),
    });
    // Busca las pendientes de ESA web y de ese cliente, no las de otra.
    expect(db.clientProduct.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ clientId: 'c1', clientSiteId: 'site_1', status: 'pending_payment' }) }),
    );
  });

  it('no ofrece nada encima de un Cuidado que ya se cobra', async () => {
    const db = fakeDb({ contracted: { id: 'cp_care_live' } });
    expect(await createCustomCareOffer(db as never, INPUT)).toEqual({ ok: false, error: 'already_contracted' });
    expect(db.clientProduct.create).not.toHaveBeenCalled();
  });

  it('no existe una cuota de 0 € ni más meses de los que admite Stripe', async () => {
    const db = fakeDb();
    expect(await createCustomCareOffer(db as never, { ...INPUT, priceCents: 0 })).toEqual({ ok: false, error: 'invalid_price' });
    expect(await createCustomCareOffer(db as never, { ...INPUT, trialMonths: 25 })).toEqual({ ok: false, error: 'invalid_trial' });
    expect(db.clientProduct.create).not.toHaveBeenCalled();
  });

  it('sin el Cuidado en el catálogo, no inventa un producto', async () => {
    const db = fakeDb({ product: null });
    expect(await createCustomCareOffer(db as never, INPUT)).toEqual({ ok: false, error: 'care_product_missing' });
  });
});

describe('withdrawCustomCareOffer', () => {
  it('solo retira una oferta pendiente de ese cliente', async () => {
    const db = fakeDb({ contracted: { id: 'cp_offer', productId: 'prod_care', tenantId: 't1' } });
    expect(await withdrawCustomCareOffer(db as never, { clientId: 'c1', clientProductId: 'cp_offer', actorId: 'op_1' })).toBe(true);
    expect(db.clientProduct.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'cp_offer', clientId: 'c1', status: 'pending_payment', customPriceCents: { not: null } }),
      }),
    );
    expect(db.clientProductAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'custom_care_withdrawn', statusAfter: 'cancelled' }),
    });
  });

  it('si el cliente la activó entretanto, no la cancela', async () => {
    const db = fakeDb({ contracted: { id: 'cp_offer', productId: 'prod_care', tenantId: 't1' } });
    db.clientProduct.updateMany.mockResolvedValue({ count: 0 });
    expect(await withdrawCustomCareOffer(db as never, { clientId: 'c1', clientProductId: 'cp_offer', actorId: 'op_1' })).toBe(false);
    expect(db.clientProductAudit.create).not.toHaveBeenCalled();
  });
});

describe('findCustomCareOffer', () => {
  it('devuelve precio, meses y moneda', async () => {
    const db = fakeDb({
      contracted: { id: 'cp_offer', customPriceCents: 8900, customTrialMonths: 12, product: { currency: 'EUR' } },
    });
    expect(await findCustomCareOffer(db as never, 'c1', 'site_1')).toEqual({
      clientProductId: 'cp_offer',
      priceCents: 8900,
      trialMonths: 12,
      currency: 'EUR',
    });
  });
});
