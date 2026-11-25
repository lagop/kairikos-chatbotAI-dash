// =============================================================================
// RGPD (25/11/2026, PR 2 del plan del encargo) — descargar todos los
// registros de llamadas de una línea. Enlaces normales con `download`, como
// ConversationsExport: el fichero se guarda según llega y no hace falta
// JavaScript. La ruta resuelve la línea desde la sesión; `clientProductId`
// solo hace falta cuando el cliente tiene varias.
//
// Sin la grabación ni su URL: el audio se borra en Twilio a los 30 días y el
// fichero dice solo si sigue disponible o cuándo se borró.
// =============================================================================

const EXPORT_URL = '/api/portal/recall/calls/export';

function href(format: 'csv' | 'json', clientProductId: string | null): string {
  const params = new URLSearchParams({ formato: format });
  if (clientProductId) params.set('clientProductId', clientProductId);
  return `${EXPORT_URL}?${params.toString()}`;
}

export function RecallCallsExport({ clientProductId }: { clientProductId: string | null }) {
  return (
    <section className="card space-y-3" aria-label="Exportar llamadas" data-testid="recall-calls-export">
      <header>
        <h2 className="text-base font-semibold">Exportar todas las llamadas</h2>
        <p className="mt-1 text-sm text-kairikos-muted">
          Todas las de esta línea, de todos los meses: fecha, número, resultado, transcripción del recado, avisos y
          devoluciones agendadas. En CSV (se abre con Excel) o en JSON. Las grabaciones no van en el fichero. También
          puedes bajarlas si das de baja el servicio, mientras dure el plazo para llevarte tus datos.
        </p>
      </header>

      <p className="card border-kairikos-warning/50 text-sm" data-testid="recall-calls-export-warning">
        <strong>El fichero tiene datos personales</strong> de quienes te han llamado: sus números y lo que dijeron en el
        recado. Guárdalo en un sitio seguro, no lo reenvíes y bórralo cuando ya no lo necesites.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <a href={href('csv', clientProductId)} download className="btn-primary" data-testid="recall-calls-export-csv">
          Descargar CSV
        </a>
        <a href={href('json', clientProductId)} download className="btn-ghost" data-testid="recall-calls-export-json">
          Descargar JSON
        </a>
      </div>
    </section>
  );
}
