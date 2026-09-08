import type { ProspectingBreakdown, ProspectingMetrics } from '@/lib/prospecting-metrics';

// =============================================================================
// Fase 3.4 — el rendimiento de la campaña de prospección, para el cliente.
//
// Componente de servidor, sin JavaScript: cada cifra va escrita, así que no
// hay nada que descubrir pasando el ratón. Las barras del desglose son un
// apoyo para comparar de un vistazo, nunca el portador del dato — el
// porcentaje está siempre escrito al lado.
//
// Una tasa que no se puede calcular se escribe "—", no "0 %". Enseñar un
// 0 % de respuesta a quien todavía no ha contactado a nadie es mentirle
// sobre su propio producto.
// =============================================================================

const PERCENT = new Intl.NumberFormat('es-ES', { style: 'percent', maximumFractionDigits: 0 });

function percentLabel(value: number | null): string {
  return value === null ? '—' : PERCENT.format(value);
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

function BreakdownTable({
  title,
  emptyHint,
  breakdown,
}: {
  title: string;
  emptyHint: string;
  breakdown: ProspectingBreakdown;
}) {
  if (breakdown.rows.length === 0) {
    return (
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-kairikos-muted">{title}</p>
        <p className="mt-1 text-sm text-kairikos-muted">{emptyHint}</p>
      </div>
    );
  }

  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-kairikos-muted">{title}</p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[26rem] text-sm">
          <thead>
            <tr className="text-left text-xs text-kairikos-muted">
              <th className="pb-1.5 font-medium">&nbsp;</th>
              <th className="pb-1.5 pl-3 font-medium">Encontrados</th>
              <th className="pb-1.5 pl-3 font-medium">Contactados</th>
              <th className="pb-1.5 pl-3 font-medium">Respondieron</th>
              <th className="pb-1.5 pl-3 font-medium">Tasa</th>
            </tr>
          </thead>
          <tbody>
            {breakdown.rows.map((row) => (
              <tr key={row.label} className="border-t border-kairikos-border/60">
                <td className="py-2 pr-3 text-kairikos-text">{row.label}</td>
                <td className="py-2 pl-3 tabular-nums text-kairikos-muted">{row.found}</td>
                <td className="py-2 pl-3 tabular-nums text-kairikos-muted">{row.contacted}</td>
                <td className="py-2 pl-3 tabular-nums text-kairikos-muted">{row.replied}</td>
                <td className="py-2 pl-3">
                  <div className="flex items-center gap-2">
                    <span className="h-1.5 w-16 shrink-0 rounded-full bg-kairikos-border" aria-hidden="true">
                      <span
                        className="block h-full rounded-full bg-kairikos-accent"
                        style={{ width: `${Math.round((row.responseRate ?? 0) * 100)}%` }}
                      />
                    </span>
                    <span className="tabular-nums text-kairikos-text">{percentLabel(row.responseRate)}</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {breakdown.hiddenGroups > 0 ? (
        <p className="mt-1.5 text-xs text-kairikos-muted">
          Y {breakdown.hiddenGroups} {breakdown.hiddenGroups === 1 ? 'búsqueda más' : 'búsquedas más'} con menos
          prospectos.
        </p>
      ) : null}
    </div>
  );
}

export function ProspectingMetricsCard({ metrics }: { metrics: ProspectingMetrics }) {
  if (metrics.found === 0) {
    return (
      <section className="card space-y-2" aria-label="Rendimiento de tu prospección" data-testid="prospecting-metrics">
        <p className="text-sm font-semibold">Rendimiento de tu prospección</p>
        <p className="text-sm text-kairikos-muted">
          En cuanto encontremos los primeros negocios verás aquí a cuántos se ha escrito, cuántos contestan y qué
          búsquedas te funcionan mejor.
        </p>
      </section>
    );
  }

  return (
    <section className="card space-y-4" aria-label="Rendimiento de tu prospección" data-testid="prospecting-metrics">
      <div>
        <p className="text-sm font-semibold">Rendimiento de tu prospección</p>
        <p className="text-xs text-kairikos-muted">
          Sobre los {metrics.found} {metrics.found === 1 ? 'negocio encontrado' : 'negocios encontrados'} desde que
          empezaste. Las tasas se calculan sobre los que ya has contactado, no sobre los encontrados.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Contactados" value={String(metrics.contacted)} hint={`de ${metrics.found} encontrados`} />
        <Stat
          label="Te respondieron"
          value={percentLabel(metrics.responseRate)}
          hint={`${metrics.replied} ${metrics.replied === 1 ? 'negocio' : 'negocios'}`}
        />
        <Stat
          label="Se convirtieron"
          value={percentLabel(metrics.conversionRate)}
          hint={`${metrics.converted} ${metrics.converted === 1 ? 'cliente' : 'clientes'}`}
        />
        <Stat
          label="Sin respuesta"
          value={String(metrics.sequenceExhausted)}
          hint="ya no reciben más mensajes"
        />
      </div>

      <BreakdownTable
        title="Por rubro"
        emptyHint="Todavía no hay prospectos con rubro registrado."
        breakdown={metrics.byCategory}
      />
      <BreakdownTable
        title="Por zona"
        emptyHint="Todavía no hay prospectos con zona registrada."
        breakdown={metrics.byLocation}
      />
    </section>
  );
}
