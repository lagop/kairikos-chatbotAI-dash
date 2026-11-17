'use client';

import { useMemo, useState } from 'react';
import { addMonths, startOfMonth, toDbDate, type IsoDate } from '@/lib/villas/dates';
import { CALENDAR_MONTHS_AHEAD, calendarHistoryStart, clampMonth, type CalendarVillaInput } from '@/lib/villas/panel-calendar';
import { monthSummary, type MonthStayInput } from '@/lib/villas/panel-month-summary';

// =============================================================================
// Reserva propia para villas — el resumen del mes (pestaña «Reservas»).
// Las cifras salen de lib/villas/panel-month-summary.ts; aquí solo se pintan.
// Los mismos meses que el calendario de ocupación: los datos son los mismos.
// =============================================================================

const eur = (cents: number) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(cents / 100);
// (`capitalize` de CSS daba «Diciembre De 2026», como en el calendario.)
const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const monthLabel = (iso: IsoDate) => cap(new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(toDbDate(iso)));
const pctText = (value: number | null) => (value === null ? '—' : `${value} %`);

export function VillasMonthSummary({
  villas,
  stays,
  today,
}: {
  villas: ReadonlyArray<CalendarVillaInput & { name: string }>;
  stays: readonly MonthStayInput[];
  today: IsoDate;
}) {
  const [month, setMonth] = useState<IsoDate>(startOfMonth(today));
  const summary = useMemo(() => monthSummary(month, villas, stays, today), [month, villas, stays, today]);
  const firstMonth = calendarHistoryStart(today);
  const lastMonth = addMonths(startOfMonth(today), CALENDAR_MONTHS_AHEAD);
  const name = new Map(villas.map((v) => [v.id, v.name]));
  const externalIncomplete = summary.month < summary.externalKnownFrom;
  const several = villas.length > 1;

  return (
    <div className="card space-y-3 text-sm" data-testid="villas-month-summary">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold" aria-live="polite" data-testid="villas-month-summary-title">
          {monthLabel(summary.month)}
        </h3>
        <div className="flex gap-1">
          {summary.month !== startOfMonth(today) ? (
            <button type="button" className="btn-ghost" onClick={() => setMonth(startOfMonth(today))}>
              Este mes
            </button>
          ) : null}
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setMonth((m) => clampMonth(addMonths(m, -1), today))}
            disabled={month <= firstMonth}
            aria-label="Mes anterior"
            data-testid="villas-month-summary-prev"
          >
            ←
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setMonth((m) => clampMonth(addMonths(m, 1), today))}
            disabled={month >= lastMonth}
            aria-label="Mes siguiente"
            data-testid="villas-month-summary-next"
          >
            →
          </button>
        </div>
      </div>

      {/* Las tres cifras que importan, grandes; el detalle por villa debajo. */}
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-kairikos-muted">Noches vendidas aquí</dt>
          <dd className="text-xl font-semibold" data-testid="villas-month-sold">
            {summary.total.soldHere} <span className="text-sm font-normal text-kairikos-muted">de {summary.total.available} disponibles</span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-kairikos-muted">Ocupación con Airbnb y Booking</dt>
          <dd className="text-xl font-semibold" data-testid="villas-month-occupancy">
            {pctText(summary.total.occupancyPct)}
            {externalIncomplete ? <span className="text-sm font-normal text-kairikos-muted"> (sin sus noches pasadas)</span> : null}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-kairikos-muted">Ingresos confirmados</dt>
          <dd className="text-xl font-semibold" data-testid="villas-month-revenue">
            {eur(summary.total.revenueCents)}
          </dd>
        </div>
      </dl>

      {several ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-left">
            <thead className="text-xs text-kairikos-muted">
              <tr>
                <th className="py-1 pr-2 font-normal">Villa</th>
                <th className="pr-2 text-right font-normal">Vendidas aquí</th>
                <th className="pr-2 text-right font-normal">Airbnb/Booking</th>
                <th className="pr-2 text-right font-normal">Cerradas</th>
                <th className="pr-2 text-right font-normal">Ocupación</th>
                <th className="text-right font-normal">Ingresos</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-kairikos-border">
              {summary.rows.map((r) => (
                <tr key={r.villaId}>
                  <td className="py-1.5 pr-2">{name.get(r.villaId)}</td>
                  <td className="pr-2 text-right tabular-nums">
                    {r.soldHere} / {r.available}
                  </td>
                  <td className="pr-2 text-right tabular-nums">{r.external}</td>
                  <td className="pr-2 text-right tabular-nums">{r.closed}</td>
                  <td className="pr-2 text-right tabular-nums">{pctText(r.occupancyPct)}</td>
                  <td className="text-right tabular-nums">{eur(r.revenueCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-kairikos-muted">
          {summary.total.external} {summary.total.external === 1 ? 'noche ocupada' : 'noches ocupadas'} en Airbnb y Booking · {summary.total.closed}{' '}
          {summary.total.closed === 1 ? 'cerrada' : 'cerradas'} a mano
        </p>
      )}

      <p className="text-xs text-kairikos-muted">
        Vendidas aquí: reservas con el depósito pagado. Ingresos: el total de esas reservas (IVA, limpieza y tasa incluidos) repartido por noches; no es lo cobrado,
        que aquí es solo el depósito. Airbnb y Booking no dicen si una noche es una reserva o un cierre tuyo allí, así que cuentan como ocupadas, no como vendidas
        {externalIncomplete ? ', y solo se saben de ayer en adelante' : ''}.
      </p>
    </div>
  );
}
