'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { addDays, addMonths, startOfMonth, toDbDate, type IsoDate } from '@/lib/villas/dates';
import {
  CALENDAR_MONTHS_AHEAD,
  calendarHistoryStart,
  checkCloseRange,
  clampMonth,
  entriesInRange,
  monthWeeks,
  nightFor,
  occupancyForVilla,
  rangeFromNights,
  type CalendarNight,
  type CalendarRequestInput,
  type CalendarVillaInput,
  type OccupancyKind,
} from '@/lib/villas/panel-calendar';

// =============================================================================
// Reserva propia para villas — calendario de ocupación del panel del dueño.
//
// Junta en una vista de mes lo que el panel tiene en listas (reservas,
// solicitudes, bloqueos de Airbnb/Booking y cierres a mano). Qué ocupa cada
// noche, y si un rango se puede cerrar, lo decide lib/villas/panel-calendar.ts;
// aquí solo se pinta y se recogen los clics.
//
// Tres usos:
// - Mirar: pulsar una noche dice qué la ocupa. Se puede ir hasta doce meses
//   atrás (histórico) y diecisiete adelante.
// - Cerrar y abrir fechas: pulsar una noche libre y luego la última cierra el
//   rango; en una noche cerrada a mano sale «Abrir». Las peticiones son las
//   mismas de siempre (/calendar add_block y remove_block), que las hace el
//   panel: este componente no llama a la red.
// - Ver una solicitud: el botón «Ver en el calendario» de cada tarjeta manda
//   un `focus` y el calendario salta a esa villa y ese mes, marca las noches y
//   dice con qué se cruzan.
//
// El color nunca es la única pista: cada noche es un botón con su texto
// completo en el aria-label y el detalle sale escrito debajo (en un móvil no
// hay hover). Un mes en móvil, dos a partir de `md`.
// =============================================================================

const KIND_CLASS: Record<OccupancyKind, string> = {
  confirmed: 'bg-kairikos-accent text-white',
  accepted: 'bg-kairikos-accent/25',
  ical: 'bg-kairikos-warning/30',
  manual: 'bg-kairikos-muted/30',
  // No bloquea: va sin relleno, con borde discontinuo.
  pending: 'border-2 border-dashed border-kairikos-warning',
};

const LEGEND: ReadonlyArray<{ kind: OccupancyKind; text: string }> = [
  { kind: 'confirmed', text: 'Reserva confirmada' },
  { kind: 'accepted', text: 'Aceptada, falta el depósito' },
  { kind: 'ical', text: 'Airbnb, Booking…' },
  { kind: 'manual', text: 'Cerrada a mano' },
  { kind: 'pending', text: 'Solicitud por responder (no bloquea)' },
];

const WEEKDAYS: ReadonlyArray<{ short: string; long: string }> = [
  { short: 'L', long: 'lunes' },
  { short: 'M', long: 'martes' },
  { short: 'X', long: 'miércoles' },
  { short: 'J', long: 'jueves' },
  { short: 'V', long: 'viernes' },
  { short: 'S', long: 'sábado' },
  { short: 'D', long: 'domingo' },
];

// Las fechas son días sin zona (dates.ts): se formatean en UTC para que no se
// corran un día en el navegador de quien mira.
// En español el mes y el día van en minúscula; solo se sube la primera letra.
// (`capitalize` de CSS daba «Diciembre De 2026».)
const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const monthLabel = (iso: IsoDate) => new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(toDbDate(iso));
const dayLabel = (iso: IsoDate) => new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(toDbDate(iso));
const shortDay = (iso: IsoDate) => new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(toDbDate(iso));
const nightsText = (n: number) => (n === 1 ? '1 noche' : `${n} noches`);
const nightsOf = (start: IsoDate, end: IsoDate) => Math.round((toDbDate(end).getTime() - toDbDate(start).getTime()) / 86_400_000);

function nightSummary(night: CalendarNight): string {
  if (night.entries.length === 0) return 'libre';
  return night.entries.map((e) => e.label).join('; ');
}

/** Lo que pide el panel: el calendario no llama a la red, le pasa la acción. */
export interface CalendarActions {
  busy: boolean;
  /** El aviso de la última acción («Cerrado.», un error…). */
  notice: ReactNode;
  closeNights: (villaId: string, start: IsoDate, end: IsoDate, note: string) => Promise<boolean>;
  openBlock: (villaId: string, blockId: string) => Promise<boolean>;
}

/** «Ver en el calendario»: cada clic trae un `nonce` nuevo, aunque sea la misma solicitud. */
export interface CalendarFocus {
  requestId: string;
  villaId: string;
  checkIn: IsoDate;
  checkOut: IsoDate;
  label: string;
  nonce: number;
}

type Selection =
  | { kind: 'night'; date: IsoDate }
  | { kind: 'range'; start: IsoDate; end: IsoDate }
  | { kind: 'request'; requestId: string; start: IsoDate; end: IsoDate; label: string };

function isSelected(sel: Selection | null, date: IsoDate): boolean {
  if (!sel) return false;
  if (sel.kind === 'night') return sel.date === date;
  return sel.start <= date && date < sel.end;
}

function Month({
  month,
  weeks,
  today,
  selection,
  onSelect,
  className,
}: {
  month: IsoDate;
  weeks: Array<Array<CalendarNight | null>>;
  today: IsoDate;
  selection: Selection | null;
  onSelect: (date: IsoDate) => void;
  className?: string;
}) {
  return (
    <table className={`w-full table-fixed border-separate border-spacing-1 text-center text-sm ${className ?? ''}`}>
      <caption className="pb-2 text-left text-sm font-semibold">{cap(monthLabel(month))}</caption>
      <thead>
        <tr>
          {WEEKDAYS.map((d) => (
            <th key={d.long} scope="col" className="py-1 text-xs font-normal text-kairikos-muted">
              <abbr title={d.long} className="no-underline">
                {d.short}
              </abbr>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {weeks.map((week, i) => (
          <tr key={i}>
            {week.map((night, j) => {
              if (!night) return <td key={`hueco-${i}-${j}`} />;
              const selected = isSelected(selection, night.date);
              return (
                <td key={night.date} className="p-0">
                  <button
                    type="button"
                    onClick={() => onSelect(night.date)}
                    aria-pressed={selected}
                    aria-label={`${dayLabel(night.date)}: ${nightSummary(night)}${night.conflict ? '. Atención: doble reserva' : ''}`}
                    data-kind={night.kind ?? 'free'}
                    data-conflict={night.conflict ? 'true' : undefined}
                    data-selected={selected ? 'true' : undefined}
                    data-testid={`villas-cal-${night.date}`}
                    className={[
                      'relative flex h-10 w-full items-center justify-center rounded-lg transition',
                      night.kind ? KIND_CLASS[night.kind] : 'hover:bg-kairikos-surface2',
                      night.date < today ? 'opacity-40' : '',
                      night.date === today ? 'font-bold underline underline-offset-4' : '',
                      night.conflict ? 'ring-2 ring-kairikos-danger' : '',
                      selected ? 'outline outline-2 outline-offset-1 outline-kairikos-text' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {Number(night.date.slice(8))}
                    {night.conflict ? (
                      <span aria-hidden className="absolute right-1 top-0.5 text-[10px] font-bold text-kairikos-danger">
                        !
                      </span>
                    ) : null}
                  </button>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function VillasCalendar({
  villas,
  requests,
  today,
  actions,
  focus,
}: {
  villas: ReadonlyArray<CalendarVillaInput & { name: string }>;
  requests: readonly CalendarRequestInput[];
  today: IsoDate;
  /** Sin acciones (p. ej. en solo lectura), el calendario solo enseña. */
  actions?: CalendarActions;
  focus?: CalendarFocus | null;
}) {
  const [villaId, setVillaId] = useState(villas[0]?.id ?? '');
  const [month, setMonth] = useState<IsoDate>(startOfMonth(today));
  const [selection, setSelection] = useState<Selection | null>(null);
  // La primera noche de un rango a cerrar, esperando la última.
  const [anchor, setAnchor] = useState<IsoDate | null>(null);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  // Si la villa elegida desaparece tras un refresco (se borró), cae en la primera.
  const villa = villas.find((v) => v.id === villaId) ?? villas[0];
  const ranges = useMemo(() => (villa ? occupancyForVilla(villa, requests) : []), [villa, requests]);
  const nextMonth = addMonths(month, 1);
  const weeks = useMemo(() => monthWeeks(month, ranges), [month, ranges]);
  const nextWeeks = useMemo(() => monthWeeks(nextMonth, ranges), [nextMonth, ranges]);

  function reset() {
    setSelection(null);
    setAnchor(null);
    setRangeError(null);
  }

  // «Ver en el calendario». Depende del objeto `focus`, que es nuevo en cada
  // clic (lleva su nonce): pulsar dos veces la misma solicitud vuelve a saltar.
  useEffect(() => {
    if (!focus) return;
    setVillaId(focus.villaId);
    setMonth(clampMonth(focus.checkIn, today));
    setSelection({ kind: 'request', requestId: focus.requestId, start: focus.checkIn, end: focus.checkOut, label: focus.label });
    setAnchor(null);
    setRangeError(null);
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    rootRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    rootRef.current?.focus({ preventScroll: true });
  }, [focus, today]);

  if (!villa) return <p className="text-sm text-kairikos-muted">Todavía no tienes ninguna villa.</p>;

  const firstMonth = calendarHistoryStart(today);
  const lastMonth = addMonths(startOfMonth(today), CALENDAR_MONTHS_AHEAD);
  const move = (step: number) => {
    setMonth((m) => clampMonth(addMonths(m, step), today));
    reset();
  };

  function select(date: IsoDate) {
    setRangeError(null);
    if (anchor === date) {
      reset();
      return;
    }
    if (anchor && actions) {
      const r = rangeFromNights(anchor, date);
      const check = checkCloseRange(ranges, r.start, r.end, today);
      if (check.ok) {
        setSelection({ kind: 'range', ...r });
        setAnchor(null);
        return;
      }
      if (check.reason === 'occupied') {
        setRangeError(`Entre esas noches hay algo ocupado (${check.blockers[0].label}). Elige otras o cierra por tramos.`);
      } else if (check.reason === 'too_long') {
        setRangeError('Como mucho un año seguido.');
      }
      // Y la noche pulsada pasa a ser la nueva selección.
    }
    const night = nightFor(date, ranges);
    const blocked = night.entries.some((e) => e.kind !== 'pending');
    setSelection({ kind: 'night', date });
    setAnchor(actions && date >= today && !blocked ? date : null);
  }

  async function close(e: FormEvent<HTMLFormElement>, start: IsoDate, end: IsoDate) {
    e.preventDefault();
    if (!actions) return;
    if (await actions.closeNights(villa.id, start, end, note.trim())) {
      setNote('');
      reset();
    }
  }

  async function open(blockId: string) {
    if (!actions) return;
    if (await actions.openBlock(villa.id, blockId)) reset();
  }

  const closeForm = (start: IsoDate, end: IsoDate, label: string) => (
    <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={(e) => void close(e, start, end)} data-testid="villas-calendar-close-form">
      <input
        className="input min-w-0 flex-1 basis-48"
        placeholder="Motivo (solo lo ves tú)"
        maxLength={120}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        aria-label="Motivo del cierre"
      />
      <button className="btn-primary" disabled={actions?.busy} data-testid="villas-calendar-close">
        {label}
      </button>
      <button type="button" className="btn-ghost" onClick={reset}>
        Cancelar
      </button>
    </form>
  );

  let detail: ReactNode;
  if (!selection) {
    detail = (
      <span className="text-kairikos-muted">
        Pulsa una noche para ver qué la ocupa.
        {actions ? ' Para cerrar fechas, pulsa la primera noche libre y después la última.' : ''}
      </span>
    );
  } else if (selection.kind === 'night') {
    const night = nightFor(selection.date, ranges);
    const manual = night.entries.filter((e) => e.kind === 'manual' && e.end > today);
    detail = (
      <>
        <p>
          <strong>{cap(dayLabel(night.date))}</strong>
          {': '}
          {night.entries.length === 0 ? 'noche libre.' : night.entries.map((e) => e.label).join(' · ')}
          {night.conflict ? <span className="font-semibold text-kairikos-danger"> · Doble reserva: revísalo.</span> : null}
        </p>
        {actions && manual.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {manual.map((m) => (
              <button key={m.id} type="button" className="btn-ghost" disabled={actions.busy} onClick={() => void open(m.id)} data-testid="villas-calendar-open">
                Abrir del {shortDay(m.start)} al {shortDay(addDays(m.end, -1))} ({nightsText(nightsOf(m.start, m.end))})
              </button>
            ))}
          </div>
        ) : null}
        {anchor === night.date ? (
          <>
            <p className="mt-2 text-kairikos-muted">Pulsa la última noche para cerrar varias, o cierra solo esta.</p>
            {closeForm(night.date, addDays(night.date, 1), 'Cerrar esta noche')}
          </>
        ) : null}
      </>
    );
  } else if (selection.kind === 'range') {
    const check = checkCloseRange(ranges, selection.start, selection.end, today);
    const pending = check.ok ? check.pending : [];
    detail = (
      <>
        <p>
          <strong>
            Cerrar del {dayLabel(selection.start)} al {dayLabel(addDays(selection.end, -1))}
          </strong>{' '}
          ({nightsText(nightsOf(selection.start, selection.end))}). El {dayLabel(selection.end)} queda libre para entrar.
        </p>
        {pending.length > 0 ? (
          <p className="mt-1 text-kairikos-warning">
            {pending.length === 1 ? 'Hay 1 solicitud por responder' : `Hay ${pending.length} solicitudes por responder`} en esas noches. Cerrar no la
            {pending.length === 1 ? '' : 's'} rechaza: contéstala{pending.length === 1 ? '' : 's'} tú.
          </p>
        ) : null}
        {closeForm(selection.start, selection.end, 'Cerrar estas noches')}
      </>
    );
  } else {
    const crossing = entriesInRange(ranges, selection.start, selection.end, selection.requestId);
    const blockers = crossing.filter((e) => e.kind !== 'pending');
    const others = crossing.filter((e) => e.kind === 'pending');
    detail = (
      <>
        <p>
          <strong>{selection.label}</strong> · del {shortDay(selection.start)} al {shortDay(selection.end)} ({nightsText(nightsOf(selection.start, selection.end))}).
        </p>
        {blockers.length > 0 ? (
          <p className="mt-1 font-semibold text-kairikos-danger" data-testid="villas-calendar-crossing">
            Se cruza con: {blockers.map((b) => `${b.label} (${shortDay(b.start)}–${shortDay(b.end)})`).join(' · ')}.
          </p>
        ) : (
          <p className="mt-1 text-kairikos-success" data-testid="villas-calendar-crossing">
            Ninguna de esas noches está ocupada.
          </p>
        )}
        {others.length > 0 ? (
          <p className="mt-1 text-kairikos-muted">
            {others.length === 1 ? 'Otra solicitud pide' : `Otras ${others.length} solicitudes piden`} alguna de esas noches.
          </p>
        ) : null}
      </>
    );
  }

  return (
    <div ref={rootRef} tabIndex={-1} className="card scroll-mt-24 space-y-4 text-sm outline-none" data-testid="villas-calendar">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {villas.length > 1 ? (
          <label className="flex items-center gap-2">
            <span className="text-kairikos-muted">Villa</span>
            <select
              className="input w-auto"
              value={villa.id}
              onChange={(e) => {
                setVillaId(e.target.value);
                reset();
              }}
              data-testid="villas-calendar-villa"
            >
              {villas.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="font-semibold">{villa.name}</span>
        )}
        <div className="flex items-center gap-2">
          {month !== startOfMonth(today) ? (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setMonth(startOfMonth(today));
                reset();
              }}
              data-testid="villas-calendar-today"
            >
              Hoy
            </button>
          ) : null}
          <button type="button" className="btn-ghost" onClick={() => move(-1)} disabled={month <= firstMonth} aria-label="Mes anterior" data-testid="villas-calendar-prev">
            ←
          </button>
          <button type="button" className="btn-ghost" onClick={() => move(1)} disabled={month >= lastMonth} aria-label="Mes siguiente" data-testid="villas-calendar-next">
            →
          </button>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Month month={month} weeks={weeks} today={today} selection={selection} onSelect={select} />
        <Month month={nextMonth} weeks={nextWeeks} today={today} selection={selection} onSelect={select} className="hidden md:table" />
      </div>

      <ul className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-kairikos-muted" aria-label="Leyenda">
        {LEGEND.map((item) => (
          <li key={item.kind} className="flex items-center gap-1.5">
            <span aria-hidden className={`inline-block h-4 w-4 rounded ${KIND_CLASS[item.kind]}`} />
            {item.text}
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-4 w-4 rounded ring-2 ring-kairikos-danger" />
          Doble reserva
        </li>
      </ul>

      <div className="min-h-[2.5rem] rounded-lg bg-kairikos-surface2 px-3 py-2" role="status" data-testid="villas-calendar-detail">
        {detail}
        {rangeError ? <p className="mt-1 text-kairikos-danger">{rangeError}</p> : null}
      </div>
      {actions?.notice}

      <p className="text-xs text-kairikos-muted">
        Cada día marca la noche que empieza ese día, así que el día de salida aparece libre. Airbnb y Booking se leen cada 30 minutos; de los meses
        pasados enseñan solo lo que aún publican.
      </p>
    </div>
  );
}
