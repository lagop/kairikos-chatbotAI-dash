import type { ReputationSummary } from '@/lib/review-reputation';

// =============================================================================
// Fase 2.1 — el resumen de reputación del cliente.
//
// Componente de servidor, sin JavaScript de cliente: cada valor del gráfico
// va etiquetado debajo de su barra, así que no hace falta pasar el ratón
// para leerlo y el color nunca es el único portador del dato. Media año de
// barras es el máximo que cabe legible en el ancho del portal.
//
// La escala del eje es 1-5 fija, la de una valoración de Google. Escalarla
// al mínimo y máximo observados haría que una diferencia de una décima
// pareciera un desplome.
// =============================================================================

const CHART_HEIGHT = 96;
const MIN_STARS = 1;
const MAX_STARS = 5;

const MONTH_LABEL = new Intl.DateTimeFormat('es-ES', { month: 'short', timeZone: 'UTC' });

function monthLabel(month: string): string {
  const [year, m] = month.split('-').map(Number);
  return MONTH_LABEL.format(new Date(Date.UTC(year, m - 1, 1))).replace('.', '');
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-kairikos-border bg-kairikos-surface2 px-4 py-3">
      <p className="text-xs uppercase tracking-wider text-kairikos-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-kairikos-text">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-kairikos-muted">{hint}</p> : null}
    </div>
  );
}

export function ReputationPanel({ summary }: { summary: ReputationSummary }) {
  if (summary.totalReviews === 0) {
    return (
      <section className="card space-y-2" aria-label="Evolución de tu reputación" data-testid="reputation-panel">
        <p className="text-sm font-semibold">Evolución de tu reputación</p>
        <p className="text-sm text-kairikos-muted">
          En cuanto tengas tu primera reseña verás aquí cómo evoluciona tu valoración mes a mes.
        </p>
      </section>
    );
  }

  const trend =
    summary.averageLast90 !== null && summary.averageRating !== null
      ? Math.round((summary.averageLast90 - summary.averageRating) * 10) / 10
      : null;

  return (
    <section className="card space-y-4" aria-label="Evolución de tu reputación" data-testid="reputation-panel">
      <div>
        <p className="text-sm font-semibold">Evolución de tu reputación</p>
        <p className="text-xs text-kairikos-muted">
          Valoración media por mes, sobre {summary.totalReviews}{' '}
          {summary.totalReviews === 1 ? 'reseña' : 'reseñas'} en total.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Valoración media"
          value={summary.averageRating !== null ? summary.averageRating.toFixed(1) : '—'}
          hint={
            trend === null || trend === 0
              ? 'Estable en los últimos 90 días'
              : trend > 0
                ? `+${trend.toFixed(1)} en los últimos 90 días`
                : `${trend.toFixed(1)} en los últimos 90 días`
          }
        />
        <Stat
          label="Reseñas nuevas"
          value={String(summary.reviewsLast30)}
          hint="En los últimos 30 días"
        />
        <Stat
          label="Respondidas"
          value={summary.responseRate !== null ? `${Math.round(summary.responseRate * 100)}%` : '—'}
          hint={
            summary.unansweredNegative > 0
              ? `${summary.unansweredNegative} negativa${summary.unansweredNegative === 1 ? '' : 's'} sin responder`
              : 'Sin negativas pendientes'
          }
        />
      </div>

      <div className="overflow-x-auto">
        <div className="flex min-w-[320px] items-end gap-3" data-testid="reputation-chart">
          {summary.months.map((month) => {
            const ratio =
              month.average === null ? 0 : (month.average - MIN_STARS) / (MAX_STARS - MIN_STARS);
            // Un mínimo visible para que un mes de 1,0 estrellas no
            // desaparezca contra la línea base y parezca "sin datos".
            const height = month.average === null ? 0 : Math.max(6, Math.round(ratio * CHART_HEIGHT));
            return (
              <div key={month.month} className="flex flex-1 flex-col items-center gap-1">
                <span className="text-xs font-medium tabular-nums text-kairikos-text">
                  {month.average !== null ? month.average.toFixed(1) : '—'}
                </span>
                <div
                  className="flex w-full items-end justify-center rounded-md bg-kairikos-surface2"
                  style={{ height: CHART_HEIGHT }}
                >
                  {month.average !== null ? (
                    <div
                      className="w-full rounded-md bg-kairikos-accent"
                      style={{ height }}
                      role="img"
                      aria-label={`${monthLabel(month.month)}: ${month.average.toFixed(1)} de media con ${month.reviews} ${month.reviews === 1 ? 'reseña' : 'reseñas'}`}
                    />
                  ) : null}
                </div>
                <span className="text-xs text-kairikos-muted">{monthLabel(month.month)}</span>
                <span className="text-[11px] tabular-nums text-kairikos-muted">
                  {month.reviews > 0 ? `${month.reviews} ${month.reviews === 1 ? 'reseña' : 'reseñas'}` : 'sin reseñas'}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <p className="text-xs text-kairikos-muted">Escala de 1 a 5 estrellas.</p>
    </section>
  );
}
