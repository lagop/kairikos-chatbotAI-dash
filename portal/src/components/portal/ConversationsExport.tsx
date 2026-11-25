// =============================================================================
// RGPD (25/11/2026, PR 1 del plan del encargo) — descargar todas las
// conversaciones del chat. Dos enlaces normales (GET con `download`): el
// navegador guarda el fichero según llega, sin pasarlo por la memoria de la
// página, y funcionan sin JavaScript. La ruta es /api/portal/conversations/
// export; el cliente sale de la sesión.
//
// Con el aviso de datos personales, como la pestaña Exportar de la cartera
// (CarteraExport.tsx): lo que se baja son mensajes de visitantes de la web,
// con nombres, teléfonos y lo que hayan querido contar.
// =============================================================================

const EXPORT_URL = '/api/portal/conversations/export';

export function ConversationsExport() {
  return (
    <section className="card space-y-3" aria-label="Exportar conversaciones" data-testid="conversations-export">
      <header>
        <h2 className="text-lg font-semibold">Exportar todas las conversaciones</h2>
        <p className="mt-1 text-sm text-kairikos-muted">
          Todas, no solo las de esta página. En CSV (una fila por mensaje, se abre con Excel) o en JSON (una entrada por
          conversación, para cargarlas en otro programa). También puedes bajarlas si das de baja el chatbot, mientras
          dure el plazo para llevarte tus datos.
        </p>
      </header>

      <p className="card border-kairikos-warning/50 text-sm" data-testid="conversations-export-warning">
        <strong>El fichero tiene datos personales</strong> de quienes han escrito a tu chatbot: nombres, teléfonos,
        correos y lo que hayan contado. Guárdalo en un sitio seguro, no lo reenvíes y bórralo cuando ya no lo necesites.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <a href={`${EXPORT_URL}?formato=csv`} download className="btn-primary" data-testid="conversations-export-csv">
          Descargar CSV
        </a>
        <a href={`${EXPORT_URL}?formato=json`} download className="btn-ghost" data-testid="conversations-export-json">
          Descargar JSON
        </a>
      </div>
    </section>
  );
}
