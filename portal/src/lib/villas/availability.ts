import { addDays, eachNight, rangesOverlap, type IsoDate } from './dates';
import { MAX_LEAD_DAYS, nightRate, type SeasonRule, type VillaPricing } from './pricing';

// =============================================================================
// Reserva propia para villas — qué noches están ocupadas.
//
// Una noche está ocupada si la cubre un bloqueo importado por iCal, un
// bloqueo manual del dueño, o una solicitud ACEPTADA (aún dentro de su plazo
// de pago) o CONFIRMADA. Las pendientes no bloquean: varias personas pueden
// pedir las mismas fechas y el dueño elige (ver request-rules.ts).
//
// Pura: quien llama reúne los rangos de la base (requests.ts) y esto decide.
// =============================================================================

export interface BusyRange {
  start: IsoDate;
  /** Salida: la noche de este día NO está ocupada. */
  end: IsoDate;
  kind: 'ical' | 'manual' | 'request';
  /** Id de la fila de origen (bloqueo o solicitud), para decir con qué choca. */
  id: string;
  label?: string | null;
}

export function conflictsFor(busy: readonly BusyRange[], checkIn: IsoDate, checkOut: IsoDate): BusyRange[] {
  return busy.filter((b) => rangesOverlap(b.start, b.end, checkIn, checkOut));
}

export function isRangeFree(busy: readonly BusyRange[], checkIn: IsoDate, checkOut: IsoDate): boolean {
  return conflictsFor(busy, checkIn, checkOut).length === 0;
}

export interface CalendarDay {
  date: IsoDate;
  /** ¿Se puede dormir esa noche? */
  available: boolean;
  nightlyCents: number;
  minNights: number;
}

/** El calendario de una villa entre `from` (incluido) y `to` (excluido): lo
 *  que pinta el widget. Los días pasados y los que quedan más allá del límite
 *  de antelación salen como no disponibles. */
export function buildCalendar(
  villa: VillaPricing,
  seasons: readonly SeasonRule[],
  busy: readonly BusyRange[],
  from: IsoDate,
  to: IsoDate,
  today: IsoDate,
): CalendarDay[] {
  const busyNights = new Set<IsoDate>();
  for (const b of busy) {
    if (!rangesOverlap(b.start, b.end, from, to)) continue;
    const start = b.start < from ? from : b.start;
    const end = b.end > to ? to : b.end;
    for (const night of eachNight(start, end)) busyNights.add(night);
  }
  const lastBookable = addDays(today, MAX_LEAD_DAYS);
  return eachNight(from, to).map((date) => {
    const rate = nightRate(villa, seasons, date);
    return {
      date,
      available: date >= today && date <= lastBookable && !busyNights.has(date),
      nightlyCents: rate.nightlyCents,
      minNights: rate.minNights,
    };
  });
}

/** Precio «desde» de una villa: la noche más barata entre el base y sus
 *  temporadas aún vigentes. Es lo que enseña la ficha sin fechas. */
export function fromPriceCents(villa: VillaPricing, seasons: readonly SeasonRule[], today: IsoDate): number {
  const live = seasons.filter((s) => s.endDate >= today).map((s) => s.nightlyCents);
  return Math.min(villa.nightlyCents, ...live);
}
