// =============================================================================
// Plan de precios del 01/10/2026 — la regla del pago anual: el año cuesta lo
// que diez meses, sin alta, y en el MRR cuenta su doceava parte.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  ANNUAL_MONTHS_CHARGED,
  annualPriceCents,
  annualSavingsCents,
  monthlyEquivalentCents,
  parseBillingInterval,
} from '@/lib/annual-billing';

describe('pago anual', () => {
  it('12 meses por el precio de 10', () => {
    expect(ANNUAL_MONTHS_CHARGED).toBe(10);
    // Los importes del plan: Llamadas Autónomo, Chatbot Pro, SEO.
    expect(annualPriceCents(12900)).toBe(129000);
    expect(annualPriceCents(17900)).toBe(179000);
    expect(annualPriceCents(19900)).toBe(199000);
  });

  it('el ahorro son dos mensualidades', () => {
    expect(annualSavingsCents(12900)).toBe(25800);
  });

  it('una anual cuenta en el MRR como la doceava parte del año; una mensual, tal cual', () => {
    expect(monthlyEquivalentCents(129000, 'year')).toBe(10750);
    expect(monthlyEquivalentCents(12900, 'month')).toBe(12900);
    // Sin intervalo (filas de antes de esta columna): mensual, que es lo que eran.
    expect(monthlyEquivalentCents(12900, null)).toBe(12900);
  });

  it('del cuerpo de la petición solo «annual» es anual', () => {
    expect(parseBillingInterval('annual')).toBe('annual');
    expect(parseBillingInterval('monthly')).toBe('monthly');
    expect(parseBillingInterval('year')).toBe('monthly');
    expect(parseBillingInterval(undefined)).toBe('monthly');
  });
});
