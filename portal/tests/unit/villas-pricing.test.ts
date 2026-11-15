// Reserva propia para villas — precio de una estancia y fechas
// (lib/villas/pricing.ts, lib/villas/dates.ts). Plan: docs/plan-reserva-villas.md.
import { describe, expect, it } from 'vitest';
import { addDays, eachNight, isIsoDate, nightsBetween, rangesOverlap, todayIn } from '@/lib/villas/dates';
import { depositFor, MIN_DEPOSIT_CENTS, nightRate, quoteStay, seasonFor, vatIncluded, type SeasonRule, type VillaPricing } from '@/lib/villas/pricing';

const villa: VillaPricing = {
  nightlyCents: 18_000,
  minNights: 2,
  cleaningFeeCents: 6_000,
  vatRateBps: 1000,
  touristTaxCents: 0,
  maxGuests: 4,
};

const seasons: SeasonRule[] = [
  { name: 'Invierno', startDate: '2026-11-01', endDate: '2027-02-28', nightlyCents: 15_000, minNights: 3 },
  { name: 'Navidad', startDate: '2026-12-20', endDate: '2027-01-06', nightlyCents: 28_000, minNights: 5 },
];

const opts = { depositPercent: 30, today: '2026-11-15' };

describe('fechas', () => {
  it('valida días que existen', () => {
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-2-3')).toBe(false);
    expect(isIsoDate(20260101)).toBe(false);
  });

  it('cuenta noches y cruza el cambio de hora y de año sin correrse', () => {
    expect(nightsBetween('2026-10-24', '2026-10-26')).toBe(2); // fin del horario de verano
    expect(eachNight('2026-12-30', '2027-01-02')).toEqual(['2026-12-30', '2026-12-31', '2027-01-01']);
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('una salida y una entrada el mismo día no se solapan', () => {
    expect(rangesOverlap('2026-12-01', '2026-12-05', '2026-12-05', '2026-12-08')).toBe(false);
    expect(rangesOverlap('2026-12-01', '2026-12-05', '2026-12-04', '2026-12-08')).toBe(true);
  });

  it('«hoy» depende de la zona de la villa', () => {
    const now = new Date('2026-11-15T23:30:00Z'); // 00:30 del 16 en Madrid, 23:30 del 15 en Canarias
    expect(todayIn('Europe/Madrid', now)).toBe('2026-11-16');
    expect(todayIn('Atlantic/Canary', now)).toBe('2026-11-15');
  });
});

describe('temporadas', () => {
  it('si dos se solapan, gana la más corta', () => {
    expect(seasonFor('2026-12-24', seasons)?.name).toBe('Navidad');
    expect(seasonFor('2026-12-19', seasons)?.name).toBe('Invierno');
    expect(seasonFor('2027-03-01', seasons)).toBeNull();
  });

  it('la última noche de la temporada está incluida', () => {
    expect(nightRate(villa, seasons, '2027-01-06').season).toBe('Navidad');
    expect(nightRate(villa, seasons, '2027-01-07').season).toBe('Invierno');
  });

  it('el resultado no depende del orden en que lleguen', () => {
    expect(seasonFor('2026-12-24', [...seasons].reverse())?.name).toBe('Navidad');
  });
});

describe('quoteStay', () => {
  it('desglosa por temporada, suma limpieza y deja el IVA incluido', () => {
    const r = quoteStay(villa, seasons, { checkIn: '2026-12-17', checkOut: '2026-12-24', adults: 2, children: 1 }, opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const q = r.quote;
    expect(q.nights).toBe(7);
    expect(q.lines).toEqual([
      { season: 'Invierno', nights: 3, nightlyCents: 15_000, subtotalCents: 45_000 },
      { season: 'Navidad', nights: 4, nightlyCents: 28_000, subtotalCents: 112_000 },
    ]);
    expect(q.accommodationCents).toBe(157_000);
    expect(q.totalCents).toBe(163_000);
    // 163.000 × 10 / 110
    expect(q.vatCents).toBe(14_818);
    expect(q.depositCents).toBe(48_900);
    expect(q.balanceCents).toBe(114_100);
    expect(q.minNights).toBe(3); // la de la noche de llegada (Invierno)
  });

  it('la estancia mínima es la de la temporada de llegada', () => {
    const r = quoteStay(villa, seasons, { checkIn: '2026-12-22', checkOut: '2026-12-25', adults: 2, children: 0 }, opts);
    expect(r).toEqual({ ok: false, error: 'min_nights', minNights: 5 });
  });

  it('la tasa turística va por adulto y noche, fuera de la base del IVA', () => {
    const r = quoteStay({ ...villa, touristTaxCents: 200 }, [], { checkIn: '2027-03-01', checkOut: '2027-03-04', adults: 2, children: 2 }, opts);
    if (!r.ok) throw new Error(r.error);
    expect(r.quote.touristTaxCents).toBe(1_200);
    expect(r.quote.totalCents).toBe(54_000 + 6_000 + 1_200);
    expect(r.quote.vatCents).toBe(vatIncluded(60_000, 1000));
  });

  it.each([
    [{ checkIn: '2026-11-10', checkOut: '2026-11-13', adults: 2, children: 0 }, 'past_dates'],
    [{ checkIn: '2026-12-10', checkOut: '2026-12-10', adults: 2, children: 0 }, 'invalid_dates'],
    [{ checkIn: '2026-12-10', checkOut: '2026-12-08', adults: 2, children: 0 }, 'invalid_dates'],
    [{ checkIn: '2026-12-10', checkOut: '2026-12-13', adults: 0, children: 2 }, 'no_adults'],
    [{ checkIn: '2026-12-10', checkOut: '2026-12-13', adults: 3, children: 2 }, 'too_many_guests'],
    [{ checkIn: '2028-12-10', checkOut: '2028-12-13', adults: 2, children: 0 }, 'too_far'],
    [{ checkIn: '2027-03-01', checkOut: '2027-06-01', adults: 2, children: 0 }, 'too_long'],
    [{ checkIn: 'mañana', checkOut: '2026-12-13', adults: 2, children: 0 }, 'invalid_dates'],
  ])('rechaza %o con %s', (input, error) => {
    const r = quoteStay(villa, seasons, input, opts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(error);
  });

  it('el depósito nunca baja del mínimo de Stripe ni pasa del total', () => {
    expect(depositFor(100, 30)).toBe(MIN_DEPOSIT_CENTS);
    expect(depositFor(40, 30)).toBe(40);
    expect(depositFor(10_000, 100)).toBe(10_000);
  });
});
