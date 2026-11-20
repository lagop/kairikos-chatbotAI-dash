'use client';

import { useState } from 'react';
import { Notice, call, errorMessage, type NoticeMessage } from './cartera-ui';

// =============================================================================
// Cartera — la pestaña Exportar (PR 6). Un botón que baja el ZIP del contrato
// (docs/exportacion.md de la plantilla web), lo que lleva dentro y el aviso de
// que contactos.csv tiene datos personales.
//
// También en la gracia de una baja: es justo cuando más hace falta. El botón
// llama antes a `?comprobar=1` (prepara el ZIP sin mandarlo) para enseñar un
// error legible si algo falla; si sale bien, navega a la descarga, que el
// navegador guarda en disco según llega.
// =============================================================================

const EXPORT_URL = '/api/portal/cartera/exportar';

export function CarteraExport({ readOnly }: { readOnly: boolean }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<NoticeMessage>(null);

  async function download() {
    setBusy(true);
    setMessage(null);
    const res = await call('GET', `${EXPORT_URL}?comprobar=1`).catch(() => ({ ok: false, data: { error: 'export_failed' } as Record<string, unknown> }));
    setBusy(false);
    if (!res.ok) {
      setMessage({ tone: 'error', text: errorMessage(res.data) });
      return;
    }
    window.location.href = EXPORT_URL;
    setMessage({ tone: 'ok', text: 'La descarga ha empezado. Con muchas fotos puede tardar unos minutos.' });
  }

  return (
    <div className="max-w-2xl space-y-4" data-testid="cartera-export">
      <p className="text-sm text-kairikos-muted">
        Un ZIP con toda tu cartera, para guardarla o para llevártela. {readOnly ? 'Sigue disponible mientras dure la baja.' : 'Puedes bajarlo cuando quieras.'}
      </p>

      <ul className="list-disc space-y-1 pl-5 text-sm">
        <li>
          <strong>Tus casas publicadas</strong>, en el formato que entiende tu web (<code>src/content/</code>), con sus fotos. Quien mantenga la web puede ponerla en marcha sin el portal.
        </li>
        <li>
          <strong>Los borradores</strong> y las casas con avisos, aparte (<code>borradores/</code>), con sus fotos.
        </li>
        <li>
          <strong>Los contactos</strong> que han llegado desde la web, en <code>contactos.csv</code> (se abre con Excel).
        </li>
        <li>
          <strong>LEEME.txt</strong>, que explica qué es cada cosa.
        </li>
      </ul>

      <p className="card border-kairikos-warning/50 text-sm" data-testid="cartera-export-warning">
        <strong>contactos.csv tiene datos personales</strong> de quienes te han escrito: nombres, correos y teléfonos. Guárdalo en un sitio seguro, no lo reenvíes y bórralo cuando ya no lo necesites.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn-primary" onClick={download} disabled={busy} data-testid="cartera-export-download">
          {busy ? 'Preparando…' : 'Descargar ZIP'}
        </button>
      </div>
      <Notice message={message} />
    </div>
  );
}
