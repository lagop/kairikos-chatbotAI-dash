// =============================================================================
// Plan de precios del 01/10/2026 — el pago anual.
//
// La regla de negocio entera cabe en dos frases: el año cuesta lo que diez
// meses, y quien paga el año no paga alta. Vive aquí, y no repartida entre el
// checkout, el catálogo público y las pantallas, porque ya pasó una vez que un
// precio dicho en tres sitios acabó siendo tres precios distintos.
//
// Sin 'server-only' a propósito: son funciones puras, y la tarjeta de
// contratación (componente de cliente) enseña el importe anual con la misma
// cuenta que cobra el servidor.
// =============================================================================

/** Meses que se cobran por un año. 12 por el precio de 10. */
export const ANNUAL_MONTHS_CHARGED = 10;

export type BillingInterval = 'monthly' | 'annual';

/** Lo que cuesta el año de un escalón de `monthlyCents` al mes. */
export function annualPriceCents(monthlyCents: number): number {
  return monthlyCents * ANNUAL_MONTHS_CHARGED;
}

/** Lo que se ahorra quien paga el año, frente a doce mensualidades. Sin contar
 *  la cuota de alta, que tampoco paga. */
export function annualSavingsCents(monthlyCents: number): number {
  return monthlyCents * 12 - annualPriceCents(monthlyCents);
}

/**
 * El importe de una suscripción traído a un mes, para el MRR.
 *
 * `amountCents` es lo que Stripe cobra por periodo: en una anual, el año
 * entero. Sumarlo tal cual multiplicaría por doce el ingreso de quien paga por
 * adelantado, que es justo el cliente al que menos hay que sobrevalorar.
 */
export function monthlyEquivalentCents(amountCents: number, interval: string | null | undefined): number {
  return interval === 'year' ? Math.round(amountCents / 12) : amountCents;
}

/** «anual» o «mensual», tal como llega en el cuerpo de la petición. Cualquier
 *  otra cosa es mensual: es lo que se cobraba siempre. */
export function parseBillingInterval(value: unknown): BillingInterval {
  return value === 'annual' ? 'annual' : 'monthly';
}
