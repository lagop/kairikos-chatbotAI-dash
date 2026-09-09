'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// =============================================================================
// Fase 6 — la única acción manual del arranque de 'recall' que no es la
// unión de un recurso (número, WhatsApp, plantillas), así que es la única
// que no encajaba en el resto del arranque cuando RecallOperatorPanel se
// escribió como solo-lectura. Vive fuera de ese panel a propósito — su
// propio comentario dice que las acciones que mueven la máquina de
// estados llegan con su propia ruta, no como botones incrustados en un
// resumen; esto es esa ruta con la mínima UI que necesita.
// =============================================================================

const ERROR_LABEL: Record<string, string> = {
  subscription_not_found: 'No se encontró la suscripción.',
  invalid_status: 'Ya no está en «pagado, sin contrato» — puede que ya se marcara.',
};

export function RecallContractSignButton({ subscriptionId }: { subscriptionId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sign() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/admin/portal/recall/contract/sign', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscriptionId }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        setError(ERROR_LABEL[detail?.error] ?? 'No se pudo guardar. Inténtalo de nuevo.');
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
    <div className="flex flex-wrap items-center gap-2" data-testid="recall-contract-sign">
      <button type="button" className="btn-primary" disabled={busy} onClick={sign} data-testid="recall-contract-sign-button">
        {busy ? 'Guardando…' : 'Marcar contrato firmado'}
      </button>
      {error ? (
        <span className="text-xs text-kairikos-danger" data-testid="recall-contract-sign-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}
