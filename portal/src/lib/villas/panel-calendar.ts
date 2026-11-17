import { addDays, addMonths, startOfMonth, toDbDate, type IsoDate } from './dates';

// =============================================================================
// Reserva propia para villas — el calendario de ocupación del panel.
//
// El panel enseñaba reservas, cierres y calendarios importados solo como
// listas: para saber si una semana estaba libre había que cruzarlas de cabeza,
// justo antes de aceptar una solicitud. Esto las junta en una vista de mes.
//
// Pura y sin 'server-only': el componente de cliente le pasa lo que ya tiene
// (VillasPanelData) y aquí se decide qué ocupa cada noche. Mismas reglas que
// dates.ts: una celda es la NOCHE que empieza ese día, y los rangos son
// [entrada, salida), así que el día de salida sale libre.
//
// OJO: esto es para MIRAR. Si una solicitud se puede aceptar lo sigue
// decidiendo el servidor (requests.ts), que relee los iCal en ese momento.
// =============================================================================

/**
 * En orden de prioridad para pintar la celda. Las cuatro primeras BLOQUEAN la
 * noche; `pending` no: varias personas pueden pedir las mismas fechas y el
 * dueño elige (availability.ts).
 */
export const OCCUPANCY_KINDS = ['confirmed', 'accepted', 'ical', 'manual', 'pending'] as const;
export type OccupancyKind = (typeof OCCUPANCY_KINDS)[number];

export interface OccupancyRange {
  id: string;
  kind: OccupancyKind;
  start: IsoDate;
  /** Salida: la noche de este día NO está ocupada. */
  end: IsoDate;
  /** Lo que se lee al pulsar la noche. */
  label: string;
}

export interface CalendarVillaInput {
  id: string;
  manualBlocks: ReadonlyArray<{ id: string; start: IsoDate; end: IsoDate; note: string | null }>;
  importedBlocks: ReadonlyArray<{ start: IsoDate; end: IsoDate; label: string }>;
}

export interface CalendarRequestInput {
  id: string;
  villaId: string;
  status: string;
  reference: string;
  guestName: string;
  checkIn: IsoDate;
  checkOut: IsoDate;
}

const REQUEST_KIND: Readonly<Record<string, OccupancyKind | undefined>> = {
  confirmed: 'confirmed',
  accepted: 'accepted',
  pending: 'pending',
};

const REQUEST_PREFIX: Readonly<Record<string, string>> = {
  confirmed: 'Reserva confirmada',
  accepted: 'Aceptada, esperando el depósito',
  pending: 'Solicitud por responder',
};

/** Todo lo que ocupa (o pide) noches de UNA villa. Las solicitudes rechazadas,
 *  caducadas o canceladas no pintan nada. */
export function occupancyForVilla(villa: CalendarVillaInput, requests: readonly CalendarRequestInput[]): OccupancyRange[] {
  const ranges: OccupancyRange[] = [];
  for (const r of requests) {
    const kind = REQUEST_KIND[r.status];
    if (r.villaId !== villa.id || !kind) continue;
    ranges.push({ id: r.id, kind, start: r.checkIn, end: r.checkOut, label: `${REQUEST_PREFIX[r.status]} · ${r.reference} · ${r.guestName}` });
  }
  villa.importedBlocks.forEach((b, i) => {
    ranges.push({ id: `ical-${i}-${b.start}`, kind: 'ical', start: b.start, end: b.end, label: `Ocupado en ${b.label}` });
  });
  for (const b of villa.manualBlocks) {
    ranges.push({ id: b.id, kind: 'manual', start: b.start, end: b.end, label: b.note ? `Cerrada a mano · ${b.note}` : 'Cerrada a mano' });
  }
  return ranges;
}

export interface CalendarNight {
  date: IsoDate;
  /** Lo que cae en esa noche, ya ordenado por prioridad. Vacío = libre. */
  entries: OccupancyRange[];
  /** El tipo que manda en el color de la celda, o null si está libre. */
  kind: OccupancyKind | null;
  /** Dos cosas que bloquean a la vez (p. ej. una reserva y Airbnb): doble reserva. */
  conflict: boolean;
}

export function nightFor(date: IsoDate, ranges: readonly OccupancyRange[]): CalendarNight {
  const entries = ranges
    .filter((r) => r.start <= date && date < r.end)
    .sort((a, b) => OCCUPANCY_KINDS.indexOf(a.kind) - OCCUPANCY_KINDS.indexOf(b.kind));
  const blocking = entries.filter((e) => e.kind !== 'pending');
  return { date, entries, kind: entries[0]?.kind ?? null, conflict: blocking.length > 1 };
}

/**
 * Las semanas de un mes, de lunes a domingo, con `null` en los huecos de antes
 * del día 1 y de después del último.
 */
export function monthWeeks(month: IsoDate, ranges: readonly OccupancyRange[]): Array<Array<CalendarNight | null>> {
  const first = startOfMonth(month);
  const next = addMonths(first, 1);
  // getUTCDay: 0 = domingo. Se pasa a 0 = lunes.
  const lead = (toDbDate(first).getUTCDay() + 6) % 7;
  const cells: Array<CalendarNight | null> = Array.from({ length: lead }, () => null);
  for (let d = first; d < next; d = addDays(d, 1)) cells.push(nightFor(d, ranges));
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: Array<Array<CalendarNight | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** Hasta dónde se puede avanzar: los datos del panel son de hoy en adelante. */
export const CALENDAR_MONTHS_AHEAD = 17;

/** Mueve el mes sin salirse de [mes de hoy, mes de hoy + CALENDAR_MONTHS_AHEAD]. */
export function clampMonth(month: IsoDate, today: IsoDate): IsoDate {
  const min = startOfMonth(today);
  const max = addMonths(min, CALENDAR_MONTHS_AHEAD);
  const m = startOfMonth(month);
  return m < min ? min : m > max ? max : m;
}
