'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// =============================================================================
// Informe mensual de resultados (28/11/2026) — el operador activa la medición
// de una web Premium y copia la URL de eventos a PUBLIC_EVENTS_ENDPOINT de su
// repositorio. Ver docs/informe-mensual-web.md y la ruta
// /api/admin/portal/web/[clientProductId]/results-tracking.
//
// La URL lleva el token, pero no es un secreto (va en el HTML de la web), así
// que se enseña siempre, no solo al emitirla.
// =============================================================================

export interface WebResultsTrackingData {
  webActive: boolean;
  /** La URL de eventos, o null si la medición no está activa. */
  endpoint: string | null;
  /** siteUrl del sitio: sin ella no se comprueba el origen de los eventos. */
  siteUrl: string | null;
  /** Último día (local) con algún evento recibido, 'YYYY-MM-DD'. */
  lastEventDay: string | null;
  /** Si el sitio tiene un Cuidado activo: sin él no sale el correo mensual. */
  hasActiveCare: boolean;
}

const ERROR_LABEL: Record<string, string> = {
  web_not_found: 'La web tiene que estar activa.',
  unauthorized: 'Tu sesión expiró: vuelve a iniciar sesión.',
  internal_error: 'Algo falló en el servidor.',
};

export function WebResultsTrackingPanel({ webClientProductId, data }: { webClientProductId: string; data: WebResultsTrackingData }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function activate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/portal/web/${webClientProductId}/results-tracking`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(ERROR_LABEL[body.error ?? ''] ?? 'No se pudo activar.');
        return;
      }
      router.refresh();
    } catch (err) {
      setError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card mt-3" data-testid="web-results-tracking">
      <h3 className="text-base font-semibold">Medición de resultados</h3>
      <p className="mt-1 text-xs text-kairikos-muted">
        La web Premium manda sus llegadas y clics (llamar, WhatsApp, formularios, chat) y el cliente recibe el día 1 de
        cada mes su informe, si tiene el Cuidado activo. Contadores por día, sin cookies ni datos del visitante.
      </p>
      {!data.webActive ? (
        <p className="mt-3 text-sm text-kairikos-muted">Se activa cuando la web esté activa (pagada).</p>
      ) : data.endpoint ? (
        <div className="mt-3 space-y-2 text-sm">
          <p>
            Activa. URL para <code>PUBLIC_EVENTS_ENDPOINT</code> en el repositorio de la web:
          </p>
          <code className="block break-all rounded-lg border border-kairikos-border p-2" data-testid="web-results-endpoint">
            {data.endpoint}
          </code>
          <p className="text-kairikos-muted">
            {data.lastEventDay ? `Último evento recibido: ${data.lastEventDay}.` : 'Aún no ha llegado ningún evento.'}
          </p>
          {!data.siteUrl ? (
            <p className="text-kairikos-danger">
              El sitio no tiene URL de la web: se cuentan eventos de cualquier origen. Ponla en el sitio del cliente.
            </p>
          ) : null}
          {!data.hasActiveCare ? (
            <p className="text-kairikos-muted">Sin Cuidado activo en esta web: se mide, pero no sale el correo mensual.</p>
          ) : null}
        </div>
      ) : (
        <div className="mt-3">
          <button type="button" className="btn-primary" disabled={busy} onClick={() => void activate()}>
            {busy ? 'Activando…' : 'Activar medición de resultados'}
          </button>
        </div>
      )}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-kairikos-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
