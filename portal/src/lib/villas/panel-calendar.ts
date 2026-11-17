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

/** Hasta dónde se puede avanzar. */
export const CALENDAR_MONTHS_AHEAD = 17;

/**
 * Cuántos meses hacia atrás. La página carga el histórico desde
 * calendarHistoryStart: estancias confirmadas y cierres manuales. De los iCal
 * importados no hay histórico: cada lectura guarda solo de ayer en adelante
 * (ical-sync.ts), así que en los meses pasados no salen. Limitación conocida.
 */
export const CALENDAR_MONTHS_BACK = 12;

/** El primer día que el calendario puede enseñar. */
export function calendarHistoryStart(today: IsoDate): IsoDate {
  return addMonths(startOfMonth(today), -CALENDAR_MONTHS_BACK);
}

/** Mueve el mes sin salirse de [inicio del histórico, mes de hoy + CALENDAR_MONTHS_AHEAD]. */
export function clampMonth(month: IsoDate, today: IsoDate): IsoDate {
  const min = calendarHistoryStart(today);
  const max = addMonths(startOfMonth(today), CALENDAR_MONTHS_AHEAD);
  const m = startOfMonth(month);
  return m < min ? min : m > max ? max : m;
}

// --- Rangos seleccionados ------------------------------------------------------

/** Dos noches pulsadas, en el orden que sea, a un rango [entrada, salida): la
 *  última noche pulsada SÍ se cierra, así que la salida es el día siguiente. */
export function rangeFromNights(a: IsoDate, b: IsoDate): { start: IsoDate; end: IsoDate } {
  const [first, last] = a <= b ? [a, b] : [b, a];
  return { start: first, end: addDays(last, 1) };
}

/** Lo que toca [start, end), en orden de prioridad. `excludeId` deja fuera la
 *  propia solicitud cuando se mira con qué se cruza. */
export function entriesInRange(ranges: readonly OccupancyRange[], start: IsoDate, end: IsoDate, excludeId?: string): OccupancyRange[] {
  return ranges
    .filter((r) => r.id !== excludeId && r.start < end && start < r.end)
    .sort((a, b) => OCCUPANCY_KINDS.indexOf(a.kind) - OCCUPANCY_KINDS.indexOf(b.kind) || (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

/** El tope de la ruta add_block. */
export const MAX_CLOSE_NIGHTS = 366;

export type CloseCheck =
  | { ok: true; nights: number; pending: OccupancyRange[] }
  | { ok: false; reason: 'past' | 'occupied' | 'too_long'; blockers: OccupancyRange[] };

/**
 * ¿Se pueden cerrar a mano esas noches desde el calendario? No en el pasado,
 * no encima de algo que ya ocupa (cerrar encima de una reserva no la anula, y
 * dejaría dos cosas en la misma noche), y no más de un año. Las solicitudes
 * por responder no lo impiden, pero se devuelven para avisar: cerrar no las
 * rechaza.
 */
export function checkCloseRange(ranges: readonly OccupancyRange[], start: IsoDate, end: IsoDate, today: IsoDate): CloseCheck {
  if (start < today) return { ok: false, reason: 'past', blockers: [] };
  const inRange = entriesInRange(ranges, start, end);
  const blockers = inRange.filter((r) => r.kind !== 'pending');
  if (blockers.length > 0) return { ok: false, reason: 'occupied', blockers };
  const nights = Math.round((toDbDate(end).getTime() - toDbDate(start).getTime()) / 86_400_000);
  if (nights > MAX_CLOSE_NIGHTS) return { ok: false, reason: 'too_long', blockers: [] };
  return { ok: true, nights, pending: inRange.filter((r) => r.kind === 'pending') };
}
