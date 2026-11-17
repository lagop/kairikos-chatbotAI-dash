import { addDays, addMonths, startOfMonth, toDbDate, type IsoDate } from './dates';
import { nightFor, occupancyForVilla, type CalendarRequestInput, type CalendarVillaInput } from './panel-calendar';

// =============================================================================
// Reserva propia para villas — el resumen del mes en la pestaña «Reservas».
//
// La pregunta del dueño a final de mes: cuántas noches he vendido y cuánto he
// ingresado. Pura y sin 'server-only', con los mismos datos que ya pinta el
// calendario de ocupación (VillasPanelData), y la misma regla para decidir
// qué ocupa cada noche (nightFor), para que las cifras cuadren con lo que se ve.
//
// Qué cuenta cada columna:
//   - Vendidas aquí: noches de reservas CONFIRMADAS (depósito pagado). Una
//     aceptada sin pagar todavía puede caerse: no se cuenta.
//   - Airbnb/Booking: noches que bloquean sus iCal. El iCal no distingue una
//     reserva de un cierre del dueño en esa plataforma, así que se llaman
//     «ocupadas», no «vendidas». Y solo existen de ayer en adelante: la lectura
//     tira lo que ya terminó (ical-sync.ts), así que en meses pasados salen 0
//     y el panel lo avisa (`externalKnownFrom`).
//   - Cerradas: cierres a mano. Se restan de las disponibles.
//   Cada noche cuenta una sola vez, por la prioridad del calendario.
//
// Ingresos: el total de cada reserva confirmada (IVA, limpieza y tasa
// incluidos) repartido por noches, y se queda la parte de las noches de este
// mes. No es lo cobrado: del total, aquí solo se cobra el depósito.
// =============================================================================

export interface MonthStayInput extends CalendarRequestInput {
  totalCents: number;
}

export interface MonthSummaryRow {
  villaId: string;
  /** Noches del mes. */
  nights: number;
  soldHere: number;
  external: number;
  closed: number;
  /** Noches del mes menos las cerradas a mano. */
  available: number;
  /** (vendidas aquí + Airbnb/Booking) / disponibles, en %, redondeado; null si no hay disponibles. */
  occupancyPct: number | null;
  revenueCents: number;
}

export interface MonthSummary {
  month: IsoDate;
  rows: MonthSummaryRow[];
  total: Omit<MonthSummaryRow, 'villaId'>;
  /** Desde qué día se saben las noches de Airbnb/Booking (ayer). Si el mes empieza antes, la columna sale incompleta. */
  externalKnownFrom: IsoDate;
}

function nightsBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((toDbDate(b).getTime() - toDbDate(a).getTime()) / 86_400_000);
}

function pct(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}

/** La parte del total de una estancia que cae en [from, to), por noches. */
export function revenueInRange(stay: { checkIn: IsoDate; checkOut: IsoDate; totalCents: number }, from: IsoDate, to: IsoDate): number {
  const nights = nightsBetween(stay.checkIn, stay.checkOut);
  if (nights <= 0) return 0;
  const start = stay.checkIn > from ? stay.checkIn : from;
  const end = stay.checkOut < to ? stay.checkOut : to;
  const inside = nightsBetween(start, end);
  if (inside <= 0) return 0;
  return Math.round((stay.totalCents * inside) / nights);
}

export function monthSummary(
  month: IsoDate,
  villas: readonly CalendarVillaInput[],
  stays: readonly MonthStayInput[],
  today: IsoDate,
): MonthSummary {
  const first = startOfMonth(month);
  const next = addMonths(first, 1);
  // Solo las confirmadas: las demás no son noches vendidas ni ingresos.
  const confirmed = stays.filter((s) => s.status === 'confirmed');

  const rows = villas.map((villa): MonthSummaryRow => {
    const ranges = occupancyForVilla(villa, confirmed);
    let nights = 0;
    let soldHere = 0;
    let external = 0;
    let closed = 0;
    for (let d = first; d < next; d = addDays(d, 1)) {
      nights++;
      const kind = nightFor(d, ranges).kind;
      if (kind === 'confirmed') soldHere++;
      else if (kind === 'ical') external++;
      else if (kind === 'manual') closed++;
    }
    const available = nights - closed;
    const revenueCents = confirmed.filter((s) => s.villaId === villa.id).reduce((sum, s) => sum + revenueInRange(s, first, next), 0);
    return { villaId: villa.id, nights, soldHere, external, closed, available, occupancyPct: pct(soldHere + external, available), revenueCents };
  });

  const sum = (key: 'nights' | 'soldHere' | 'external' | 'closed' | 'available' | 'revenueCents') => rows.reduce((acc, r) => acc + r[key], 0);
  const total = {
    nights: sum('nights'),
    soldHere: sum('soldHere'),
    external: sum('external'),
    closed: sum('closed'),
    available: sum('available'),
    occupancyPct: pct(sum('soldHere') + sum('external'), sum('available')),
    revenueCents: sum('revenueCents'),
  };
  return { month: first, rows, total, externalKnownFrom: addDays(today, -1) };
}
