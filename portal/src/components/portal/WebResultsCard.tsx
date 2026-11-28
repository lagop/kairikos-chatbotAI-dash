import { WEB_RESULT_ROWS, contactosDe, formatChange, type WebResultsPanelData } from '@/lib/web-results-report';

// =============================================================================
// Informe mensual de resultados (28/11/2026) — lo mismo que el correo del
// día 1, en el panel: el último mes completo y lo que va del actual.
//
// Componente de servidor sin estado: la página calcula las cifras con
// computeWebResults (el mismo cálculo que el correo) y esto solo las pinta.
// Las filas y sus textos salen de WEB_RESULT_ROWS para que la pantalla y el
// correo no digan cosas distintas.
// =============================================================================

export type WebResultsCardProps = WebResultsPanelData;

const NUMBER = new Intl.NumberFormat('es-ES');

export function WebResultsCard(props: WebResultsCardProps) {
  if (!props.measuring) {
    return (
      <section className="card p-5" aria-label="Resultados de la web" data-testid="web-results" data-state="inactive">
        <h2 className="text-base font-semibold">Resultados de la web</h2>
        <p className="mt-2 text-sm text-kairikos-muted">
          La medición de resultados aún no está activa en tu web. Cuando la activemos verás aquí, cada mes, las
          llamadas, los WhatsApp, los formularios y las visitas que llegan desde tu web.
        </p>
      </section>
    );
  }

  const { lastMonth, monthBefore, currentMonth } = props;
  // La fila de llamadas recuperadas solo tiene sentido con Modo Recado.
  const rows = WEB_RESULT_ROWS.filter(
    (r) => r.key !== 'llamadasRecuperadas' || lastMonth.llamadasRecuperadas > 0 || currentMonth.llamadasRecuperadas > 0,
  );
  const contactos = contactosDe(lastMonth);

  return (
    <section className="space-y-3" aria-label="Resultados de la web" data-testid="web-results" data-state="active">
      <header>
        <h2 className="text-lg font-semibold">Resultados de la web</h2>
        <p className="mt-1 text-sm text-kairikos-muted">
          En <span className="capitalize">{props.lastMonthLabel}</span>, {NUMBER.format(contactos)}{' '}
          {contactos === 1 ? 'contacto' : 'contactos'} desde tu web: llamadas, WhatsApp, emails y formularios. El día 1
          de cada mes te mandamos este resumen por email.
        </p>
      </header>
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm" data-testid="web-results-table">
          <thead>
            <tr className="border-b border-kairikos-border text-left text-xs uppercase tracking-wide text-kairikos-muted">
              <th scope="col" className="px-4 py-2 font-medium">
                Qué
              </th>
              <th scope="col" className="px-4 py-2 text-right font-medium capitalize">
                {props.lastMonthLabel}
              </th>
              <th scope="col" className="px-4 py-2 text-right font-medium">
                Frente al mes anterior
              </th>
              <th scope="col" className="px-4 py-2 text-right font-medium">
                <span className="capitalize">{props.currentMonthLabel}</span> (hasta hoy)
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-b border-kairikos-border last:border-0">
                <th scope="row" className="px-4 py-2 text-left font-normal">
                  <span className="block">{r.label}</span>
                  <span className="block text-xs text-kairikos-muted">{r.hint}</span>
                </th>
                <td className="px-4 py-2 text-right tabular-nums" data-testid={`web-results-${r.key}`}>
                  {NUMBER.format(lastMonth[r.key])}
                  {r.key === 'formularios' && lastMonth.reservas > 0 ? (
                    <span className="block text-xs text-kairikos-muted">
                      {NUMBER.format(lastMonth.reservas)} {lastMonth.reservas === 1 ? 'reserva' : 'reservas'}
                    </span>
                  ) : null}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-right text-kairikos-muted tabular-nums">
                  {formatChange(lastMonth[r.key], monthBefore[r.key])}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {NUMBER.format(currentMonth[r.key])}
                  {r.key === 'formularios' && currentMonth.reservas > 0 ? (
                    <span className="block text-xs text-kairikos-muted">
                      {NUMBER.format(currentMonth.reservas)} {currentMonth.reservas === 1 ? 'reserva' : 'reservas'}
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-kairikos-muted">
        Las cifras cuentan toques y envíos en tu web, no citas. Se miden sin cookies y sin guardar datos de quien te
        visita.
      </p>
    </section>
  );
}
