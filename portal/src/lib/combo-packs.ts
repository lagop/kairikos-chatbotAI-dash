// =============================================================================
// Plan de precios del 01/10/2026 — los packs de productos.
//
//   Pack Oficio     Llamadas Autónomo + Reseñas Basic        228 → 199 €/mes
//   Pack Presencia  Web + Cuidado de la web + Reseñas Basic  799 € + 128 → 109 €/mes
//
// Sustituyen al «15 % por combinar» del Resumen, que nunca llegó a estar en el
// código. No son un producto que se compra: son un descuento que se aplica
// solo cuando el cliente tiene la combinación, y que se quita cuando deja de
// tenerla. El descuento va siempre en la suscripción de Reseñas Basic, que
// está en los dos (lib/pack-discounts.ts lo aplica en Stripe).
//
// Sin 'server-only': funciones puras que usan también el catálogo público y
// los tests.
// =============================================================================

export interface PackComponent {
  code: string;
  /** Sin tier: vale cualquier escalón del producto. */
  tier?: string;
  label: string;
}

export interface ComboPack {
  label: string;
  components: PackComponent[];
  /** Lo que se descuenta cada mes, en céntimos. En una anual, ×10. */
  discountMonthlyCents: number;
}

/** El escalón que lleva el descuento: está en los dos packs. */
export const DISCOUNTED_COMPONENT = { code: 'reviews', tier: 'basic' } as const;

export const COMBO_PACKS = {
  oficio: {
    label: 'Pack Oficio',
    components: [
      { code: 'recall', tier: 'solo', label: 'Llamadas Autónomo' },
      { code: 'reviews', tier: 'basic', label: 'Reseñas Basic' },
    ],
    discountMonthlyCents: 2900,
  },
  presencia: {
    label: 'Pack Presencia',
    components: [
      { code: 'web', label: 'Tu web' },
      { code: 'web_care', label: 'Cuidado de la web' },
      { code: 'reviews', tier: 'basic', label: 'Reseñas Basic' },
    ],
    discountMonthlyCents: 1900,
  },
} as const satisfies Record<string, ComboPack>;

export type ComboPackCode = keyof typeof COMBO_PACKS;

export function isComboPackCode(value: string): value is ComboPackCode {
  return Object.prototype.hasOwnProperty.call(COMBO_PACKS, value);
}

/**
 * Qué pack corresponde a un cliente con estas contrataciones activas, o null.
 *
 * Si cumple los dos (tiene de todo), gana el de mayor descuento: un cliente no
 * acumula packs, porque los dos descuentan la misma suscripción.
 */
export function qualifyingPack(active: ReadonlyArray<{ code: string; tier: string }>): ComboPackCode | null {
  const has = (c: PackComponent) => active.some((a) => a.code === c.code && (!c.tier || a.tier === c.tier));
  const candidates = (Object.keys(COMBO_PACKS) as ComboPackCode[]).filter((code) =>
    (COMBO_PACKS[code].components as readonly PackComponent[]).every(has),
  );
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => COMBO_PACKS[b].discountMonthlyCents - COMBO_PACKS[a].discountMonthlyCents)[0];
}

/** El descuento del cupón según cómo se cobra la suscripción de Reseñas. */
export function packCouponAmountCents(pack: ComboPackCode, interval: 'month' | 'year'): number {
  const monthly = COMBO_PACKS[pack].discountMonthlyCents;
  return interval === 'year' ? monthly * 10 : monthly;
}

export interface PackPricing {
  /** Lo que se paga al mes con el pack. */
  monthlyCents: number;
  /** Lo que se pagaría al mes por separado. */
  separateMonthlyCents: number;
  /** Pago único (la web), 0 si no lleva. */
  oneTimeCents: number;
}

/**
 * El precio de un pack a partir de los precios del catálogo. null si falta
 * algún componente: un pack con una pieza que no existe no se anuncia.
 */
export function packPricing(
  pack: ComboPackCode,
  prices: ReadonlyArray<{ code: string; tier: string; priceCents: number; setupFeeCents: number }>,
): PackPricing | null {
  let separate = 0;
  let oneTime = 0;
  for (const c of COMBO_PACKS[pack].components as readonly PackComponent[]) {
    const row = prices.find((p) => p.code === c.code && (!c.tier || p.tier === c.tier));
    if (!row) return null;
    separate += row.priceCents;
    // Solo la web es de pago único; el alta de los demás no forma parte del pack.
    if (row.priceCents === 0) oneTime += row.setupFeeCents;
  }
  return {
    monthlyCents: separate - COMBO_PACKS[pack].discountMonthlyCents,
    separateMonthlyCents: separate,
    oneTimeCents: oneTime,
  };
}
