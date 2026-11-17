'use client';

import { useMemo, useState } from 'react';
import { addMonths, startOfMonth, toDbDate, type IsoDate } from '@/lib/villas/dates';
import {
  CALENDAR_MONTHS_AHEAD,
  clampMonth,
  monthWeeks,
  nightFor,
  occupancyForVilla,
  type CalendarNight,
  type CalendarRequestInput,
  type CalendarVillaInput,
  type OccupancyKind,
} from '@/lib/villas/panel-calendar';

// =============================================================================
// Reserva propia para villas — calendario de ocupación del panel del dueño.
//
// Solo lectura: junta en una vista de mes lo que el panel ya tenía en listas
// (reservas, solicitudes, bloqueos de Airbnb/Booking y cierres a mano). Qué
// ocupa cada noche lo decide lib/villas/panel-calendar.ts; aquí solo se pinta.
//
// El color nunca es la única pista: cada noche es un botón con su texto
// completo en el aria-label y, al pulsarla, el detalle sale escrito debajo
// (en un móvil no hay hover). Un mes en móvil, dos a partir de `md`.
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

function nightSummary(night: CalendarNight): string {
  if (night.entries.length === 0) return 'libre';
  return night.entries.map((e) => e.label).join('; ');
}

function Month({
  month,
  weeks,
  today,
  selected,
  onSelect,
  className,
}: {
  month: IsoDate;
  weeks: Array<Array<CalendarNight | null>>;
  today: IsoDate;
  selected: IsoDate | null;
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
            {week.map((night, j) =>
              night ? (
                <td key={night.date} className="p-0">
                  <button
                    type="button"
                    onClick={() => onSelect(night.date)}
                    aria-pressed={selected === night.date}
                    aria-label={`${dayLabel(night.date)}: ${nightSummary(night)}${night.conflict ? '. Atención: doble reserva' : ''}`}
                    data-kind={night.kind ?? 'free'}
                    data-conflict={night.conflict ? 'true' : undefined}
                    data-testid={`villas-cal-${night.date}`}
                    className={[
                      'relative flex h-10 w-full items-center justify-center rounded-lg transition',
                      night.kind ? KIND_CLASS[night.kind] : 'hover:bg-kairikos-surface2',
                      night.date < today ? 'opacity-40' : '',
                      night.date === today ? 'font-bold underline underline-offset-4' : '',
                      night.conflict ? 'ring-2 ring-kairikos-danger' : '',
                      selected === night.date ? 'outline outline-2 outline-offset-1 outline-kairikos-text' : '',
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
              ) : (
                <td key={`hueco-${i}-${j}`} />
              ),
            )}
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
}: {
  villas: ReadonlyArray<CalendarVillaInput & { name: string }>;
  requests: readonly CalendarRequestInput[];
  today: IsoDate;
}) {
  const [villaId, setVillaId] = useState(villas[0]?.id ?? '');
  const [month, setMonth] = useState<IsoDate>(startOfMonth(today));
  const [selected, setSelected] = useState<IsoDate | null>(null);

  // Si la villa elegida desaparece tras un refresco (se borró), cae en la primera.
  const villa = villas.find((v) => v.id === villaId) ?? villas[0];
  const ranges = useMemo(() => (villa ? occupancyForVilla(villa, requests) : []), [villa, requests]);
  const nextMonth = addMonths(month, 1);
  const weeks = useMemo(() => monthWeeks(month, ranges), [month, ranges]);
  const nextWeeks = useMemo(() => monthWeeks(nextMonth, ranges), [nextMonth, ranges]);

  if (!villa) return <p className="text-sm text-kairikos-muted">Todavía no tienes ninguna villa.</p>;

  const firstMonth = startOfMonth(today);
  const lastMonth = addMonths(firstMonth, CALENDAR_MONTHS_AHEAD);
  const move = (step: number) => {
    setMonth((m) => clampMonth(addMonths(m, step), today));
    setSelected(null);
  };
  const selectedNight = selected ? nightFor(selected, ranges) : null;

  return (
    <div className="card space-y-4 text-sm" data-testid="villas-calendar">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {villas.length > 1 ? (
          <label className="flex items-center gap-2">
            <span className="text-kairikos-muted">Villa</span>
            <select
              className="input w-auto"
              value={villa.id}
              onChange={(e) => {
                setVillaId(e.target.value);
                setSelected(null);
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
          <button type="button" className="btn-ghost" onClick={() => move(-1)} disabled={month <= firstMonth} aria-label="Mes anterior" data-testid="villas-calendar-prev">
            ←
          </button>
          <button type="button" className="btn-ghost" onClick={() => move(1)} disabled={month >= lastMonth} aria-label="Mes siguiente" data-testid="villas-calendar-next">
            →
          </button>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Month month={month} weeks={weeks} today={today} selected={selected} onSelect={setSelected} />
        <Month month={nextMonth} weeks={nextWeeks} today={today} selected={selected} onSelect={setSelected} className="hidden md:table" />
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

      <p className="min-h-[2.5rem] rounded-lg bg-kairikos-surface2 px-3 py-2" role="status" data-testid="villas-calendar-detail">
        {selectedNight ? (
          <>
            <strong>{cap(dayLabel(selectedNight.date))}</strong>
            {': '}
            {selectedNight.entries.length === 0 ? 'noche libre.' : selectedNight.entries.map((e) => e.label).join(' · ')}
            {selectedNight.conflict ? <span className="font-semibold text-kairikos-danger"> · Doble reserva: revísalo.</span> : null}
          </>
        ) : (
          <span className="text-kairikos-muted">Pulsa una noche para ver qué la ocupa.</span>
        )}
      </p>

      <p className="text-xs text-kairikos-muted">
        Cada día marca la noche que empieza ese día, así que el día de salida aparece libre. Airbnb y Booking se leen cada 30 minutos.
      </p>
    </div>
  );
}
