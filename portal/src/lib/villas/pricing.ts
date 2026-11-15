import { addDays, eachNight, isIsoDate, nightsBetween, type IsoDate } from './dates';

// =============================================================================
// Reserva propia para villas — el precio de una estancia.
//
// Reglas (docs/plan-reserva-villas.md, «Precio»):
//   - Los precios por noche llevan el IVA INCLUIDO: es lo que ve el huésped, y
//     la regla de la web es que el total con IVA se ve antes de pagar. El IVA
//     solo se desglosa, no se suma.
//   - Temporadas por rango con la última noche incluida. Si dos se solapan,
//     gana la más corta: así «Navidad» dentro de «Invierno» no obliga a partir
//     el invierno en dos.
//   - Estancia mínima: la de la temporada de la noche de LLEGADA. Es la
//     costumbre del sector (y la de Airbnb): una semana que empieza en
//     temporada baja y acaba en alta se rige por la baja.
//   - Limpieza por estancia (con IVA) y tasa turística por adulto y noche
//     (fuera de la base del IVA; hoy 0 en Canarias y Andalucía).
//   - Sin descuentos, ofertas ni precios tachados: no existen en el modelo.
//
// Pura y sin 'server-only': la usan la ruta pública de presupuesto, la de
// solicitud (que congela el resultado en VillaBookingRequest.quote), el panel y
// los tests. El widget NO la importa: pide el presupuesto al servidor, que es
// quien manda.
// =============================================================================

export interface VillaPricing {
  nightlyCents: number;
  minNights: number;
  cleaningFeeCents: number;
  vatRateBps: number;
  touristTaxCents: number;
  maxGuests: number;
}

export interface SeasonRule {
  name: string;
  /** Primera noche de la temporada. */
  startDate: IsoDate;
  /** Última noche de la temporada (incluida). */
  endDate: IsoDate;
  nightlyCents: number;
  minNights: number;
}

export interface StayInput {
  checkIn: IsoDate;
  checkOut: IsoDate;
  adults: number;
  children: number;
}

export interface QuoteOptions {
  depositPercent: number;
  /** Hoy en la zona de la villa. No se puede llegar antes de hoy. */
  today: IsoDate;
  currency?: string;
}

/** Noches agrupadas por precio y temporada, para el desglose. */
export interface QuoteLine {
  /** Nombre de la temporada, o null para el precio base. */
  season: string | null;
  nights: number;
  nightlyCents: number;
  subtotalCents: number;
}

export interface StayQuote {
  checkIn: IsoDate;
  checkOut: IsoDate;
  nights: number;
  adults: number;
  children: number;
  lines: QuoteLine[];
  accommodationCents: number;
  cleaningFeeCents: number;
  touristTaxCents: number;
  /** Lo que paga el huésped en total, IVA incluido. */
  totalCents: number;
  /** El IVA contenido en el total (alojamiento + limpieza). */
  vatCents: number;
  vatRateBps: number;
  depositPercent: number;
  depositCents: number;
  balanceCents: number;
  minNights: number;
  currency: string;
}

export type QuoteError =
  | 'invalid_dates'
  | 'past_dates'
  | 'too_far'
  | 'too_long'
  | 'min_nights'
  | 'no_adults'
  | 'too_many_guests';

export type QuoteResult = { ok: true; quote: StayQuote } | { ok: false; error: QuoteError; minNights?: number };

/** Estancia máxima por solicitud. Más de dos meses ya no es una villa de vacaciones. */
export const MAX_NIGHTS = 60;
/** Hasta cuándo se puede pedir: unos 18 meses, lo que suelen abrir las plataformas. */
export const MAX_LEAD_DAYS = 540;
/** Stripe no cobra menos de 0,50 €. */
export const MIN_DEPOSIT_CENTS = 50;

/** La temporada que rige una noche: entre las que la contienen, la más corta.
 *  Empate: la que empieza más tarde (la más específica), y luego la más cara,
 *  para que el resultado no dependa del orden en que lleguen de la base. */
export function seasonFor(night: IsoDate, seasons: readonly SeasonRule[]): SeasonRule | null {
  let best: SeasonRule | null = null;
  let bestSpan = Infinity;
  for (const s of seasons) {
    if (night < s.startDate || night > s.endDate) continue;
    const span = nightsBetween(s.startDate, s.endDate);
    if (
      best === null ||
      span < bestSpan ||
      (span === bestSpan && (s.startDate > best.startDate || (s.startDate === best.startDate && s.nightlyCents > best.nightlyCents)))
    ) {
      best = s;
      bestSpan = span;
    }
  }
  return best;
}

/** Precio y estancia mínima de una noche suelta (para el calendario). */
export function nightRate(villa: VillaPricing, seasons: readonly SeasonRule[], night: IsoDate) {
  const season = seasonFor(night, seasons);
  return {
    season: season?.name ?? null,
    nightlyCents: season?.nightlyCents ?? villa.nightlyCents,
    minNights: season?.minNights ?? villa.minNights,
  };
}

/** IVA contenido en un importe que ya lo incluye. */
export function vatIncluded(grossCents: number, vatRateBps: number): number {
  return Math.round((grossCents * vatRateBps) / (10_000 + vatRateBps));
}

export function depositFor(totalCents: number, depositPercent: number): number {
  const deposit = Math.round((totalCents * depositPercent) / 100);
  return Math.min(totalCents, Math.max(MIN_DEPOSIT_CENTS, deposit));
}

export function quoteStay(
  villa: VillaPricing,
  seasons: readonly SeasonRule[],
  input: StayInput,
  options: QuoteOptions,
): QuoteResult {
  const { checkIn, checkOut } = input;
  if (!isIsoDate(checkIn) || !isIsoDate(checkOut)) return { ok: false, error: 'invalid_dates' };
  const nights = nightsBetween(checkIn, checkOut);
  if (nights < 1) return { ok: false, error: 'invalid_dates' };
  if (checkIn < options.today) return { ok: false, error: 'past_dates' };
  if (checkIn > addDays(options.today, MAX_LEAD_DAYS)) return { ok: false, error: 'too_far' };
  if (nights > MAX_NIGHTS) return { ok: false, error: 'too_long' };
  if (!Number.isInteger(input.adults) || input.adults < 1) return { ok: false, error: 'no_adults' };
  if (!Number.isInteger(input.children) || input.children < 0) return { ok: false, error: 'too_many_guests' };
  if (input.adults + input.children > villa.maxGuests) return { ok: false, error: 'too_many_guests' };

  const minNights = nightRate(villa, seasons, checkIn).minNights;
  if (nights < minNights) return { ok: false, error: 'min_nights', minNights };

  const lines: QuoteLine[] = [];
  for (const night of eachNight(checkIn, checkOut)) {
    const rate = nightRate(villa, seasons, night);
    const line = lines.find((l) => l.season === rate.season && l.nightlyCents === rate.nightlyCents);
    if (line) {
      line.nights += 1;
      line.subtotalCents += rate.nightlyCents;
    } else {
      lines.push({ season: rate.season, nights: 1, nightlyCents: rate.nightlyCents, subtotalCents: rate.nightlyCents });
    }
  }

  const accommodationCents = lines.reduce((sum, l) => sum + l.subtotalCents, 0);
  const touristTaxCents = villa.touristTaxCents * input.adults * nights;
  const taxable = accommodationCents + villa.cleaningFeeCents;
  const totalCents = taxable + touristTaxCents;
  const depositCents = depositFor(totalCents, options.depositPercent);

  return {
    ok: true,
    quote: {
      checkIn,
      checkOut,
      nights,
      adults: input.adults,
      children: input.children,
      lines,
      accommodationCents,
      cleaningFeeCents: villa.cleaningFeeCents,
      touristTaxCents,
      totalCents,
      vatCents: vatIncluded(taxable, villa.vatRateBps),
      vatRateBps: villa.vatRateBps,
      depositPercent: options.depositPercent,
      depositCents,
      balanceCents: totalCents - depositCents,
      minNights,
      currency: options.currency ?? 'EUR',
    },
  };
}

/** «1.234,50 €» — el formato de los correos y de la página del huésped. */
export function formatCents(cents: number, currency = 'EUR', locale = 'es-ES'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
}
